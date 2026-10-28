import { randomUUID } from "node:crypto";
import { keccak256 } from "ethers";

const TERMINAL_BUSINESS = new Set(["CONFIRMED", "CLAIM_CONFLICT", "EXPIRED_UNSENT", "NEEDS_RECONCILIATION"]);
const RECONCILE_STATUSES = [
  "SIGNED", "PENDING", "BROADCAST_UNKNOWN", "MINED_SUCCESS", "MINED_REVERTED",
  "CONFIRMED", "CLAIM_CONFLICT",
];

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function dateDay(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function safeError(error) {
  const message = String(error?.shortMessage || error?.message || "broadcast failed");
  return message.replace(/0x[0-9a-fA-F]{20,}/g, "0x…").slice(0, 240);
}

function claimArgs(job) {
  return {
    seriesId: BigInt(job.series_id),
    serial: Number(job.serial),
    credentialSigner: job.credential_signer,
    proof: jsonArray(job.proof),
    recipient: job.recipient,
    deadline: BigInt(job.deadline),
    signature: job.signature,
  };
}

export class ClaimWorker {
  constructor({ db, chain, config, signer, clock = Date.now, logger = console }) {
    this.db = db;
    this.chain = chain;
    this.config = config;
    this.signer = signer;
    this.clock = clock;
    this.logger = logger;
    this.running = false;
    this.timer = null;
  }

  log(event, fields = {}) {
    const line = { event, ...fields };
    if (typeof this.logger?.info === "function") this.logger.info(line);
  }

  warn(event, fields = {}) {
    const line = { event, ...fields };
    if (typeof this.logger?.warn === "function") this.logger.warn(line);
  }

  async tick() {
    const recovered = await this.recoverUnbroadcast();
    const queued = await this.processQueued();
    const reconciled = await this.reconcileOpenJobs();
    return { recovered, queued, reconciled };
  }

  start({ intervalMs = 5000 } = {}) {
    if (this.running) return;
    if (!this.signer) throw new Error("A relayer signer is required to start the claim worker.");
    this.running = true;
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.warn("worker_tick_failed", { error: safeError(error) });
      } finally {
        if (this.running) this.timer = setTimeout(loop, intervalMs);
      }
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async processQueued(limit = 5) {
    if (this.config.sponsorPaused || !this.signer) return 0;
    const result = await this.db.query(
      "SELECT id FROM claim_jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT $1",
      [limit],
    );
    let processed = 0;
    for (const row of result.rows) {
      try {
        const signed = await this.signAndBroadcast(row.id);
        if (signed) processed += 1;
      } catch (error) {
        this.warn("claim_sign_failed", { jobId: row.id, error: safeError(error) });
      }
    }
    return processed;
  }

  async signAndBroadcast(jobId) {
    if (this.config.sponsorPaused || !this.signer) return false;
    const loaded = await this.db.query("SELECT * FROM claim_jobs WHERE id = $1", [jobId]);
    const job = loaded.rows[0];
    if (!job || job.status !== "QUEUED") return false;

    const now = this.clock();
    if (BigInt(job.deadline) <= BigInt(Math.floor(now / 1000))) {
      await this.markJob(jobId, "EXPIRED_UNSENT", { error_code: "AUTHORIZATION_EXPIRED" });
      return false;
    }

    const preflight = await this.preflight(job);
    if (!preflight.ok) return false;

    let fee;
    let gasLimit;
    try {
      fee = await this.chain.getFeeData();
      gasLimit = await this.chain.estimateClaimGas(claimArgs(job));
    } catch (error) {
      this.warn("claim_preflight_chain_failed", { jobId, error: safeError(error) });
      return false;
    }

    if (fee.maxFeePerGas > this.config.maxFeePerGasWei) {
      await this.block(jobId, "FEE_TOO_HIGH");
      return false;
    }
    if (gasLimit > this.config.maxGasPerTx) {
      await this.block(jobId, "GAS_LIMIT_EXCEEDED");
      return false;
    }
    const worstCost = gasLimit * fee.maxFeePerGas;

    let chainNonce;
    try {
      chainNonce = await this.chain.getTransactionCount(this.config.relayerAddress);
    } catch (error) {
      this.warn("claim_nonce_read_failed", { jobId, error: safeError(error) });
      return false;
    }

    let signed = null;
    try {
      signed = await this.db.transaction(async (tx) => {
        const locked = await tx.query("SELECT * FROM claim_jobs WHERE id = $1 FOR UPDATE", [jobId]);
        const current = locked.rows[0];
        if (!current || current.status !== "QUEUED") return null;

        const openSlot = await tx.query(
          "SELECT 1 FROM nonce_slots WHERE job_id = $1 AND finalized_at IS NULL LIMIT 1",
          [jobId],
        );
        if (openSlot.rows[0]) return null;

        await tx.query(
          `INSERT INTO relayer_state (chain_id, relayer_address)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [String(this.config.chainId), this.config.relayerAddress.toLowerCase()],
        );
        await tx.query(
          "SELECT 1 FROM relayer_state WHERE chain_id = $1 AND relayer_address = $2 FOR UPDATE",
          [String(this.config.chainId), this.config.relayerAddress.toLowerCase()],
        );

        const today = dayKey(now);
        await tx.query(
          `INSERT INTO sponsor_budget (chain_id, budget_day)
           VALUES ($1, $2) ON CONFLICT (chain_id) DO NOTHING`,
          [String(this.config.chainId), today],
        );
        const budgetRow = await tx.query(
          "SELECT * FROM sponsor_budget WHERE chain_id = $1 FOR UPDATE",
          [String(this.config.chainId)],
        );
        let budget = budgetRow.rows[0];
        if (!budget) return null;
        if (dateDay(budget.budget_day) !== today) {
          await tx.query(
            "UPDATE sponsor_budget SET budget_day = $2, spent_wei = 0, updated_at = now() WHERE chain_id = $1",
            [String(this.config.chainId), today],
          );
          budget = { ...budget, budget_day: today, spent_wei: "0" };
        }
        const available = this.config.dailyBudgetWei - BigInt(budget.spent_wei) - BigInt(budget.reserved_wei);
        if (available < worstCost) {
          await tx.query(
            "UPDATE claim_jobs SET blocked_reason = 'BUDGET_EXHAUSTED', updated_at = now() WHERE id = $1",
            [jobId],
          );
          return null;
        }

        const local = await tx.query(
          `SELECT COALESCE(MAX(nonce), -1) AS max_nonce FROM nonce_slots
           WHERE chain_id = $1 AND relayer_address = $2`,
          [String(this.config.chainId), this.config.relayerAddress.toLowerCase()],
        );
        const nonce = Math.max(chainNonce, Number(local.rows[0].max_nonce) + 1);
        if (!Number.isSafeInteger(nonce)) throw new Error("Nonce is outside the safe integer range.");

        const txRequest = {
          to: this.config.contractAddress,
          value: 0n,
          data: this.chain.encodeClaimData(claimArgs(current)),
          chainId: Number(this.config.chainId),
          nonce,
          gasLimit,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          type: 2,
        };
        const rawSignedTx = await this.signer.signTransaction(txRequest);
        const hash = keccak256(rawSignedTx);

        const slotResult = await tx.query(
          `INSERT INTO nonce_slots (id, chain_id, relayer_address, nonce, job_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (chain_id, relayer_address, nonce) DO NOTHING
           RETURNING *`,
          [
            randomUUID(), String(this.config.chainId),
            this.config.relayerAddress.toLowerCase(), nonce, jobId,
          ],
        );
        const slot = slotResult.rows[0];
        if (!slot) return null;

        const attemptResult = await tx.query(
          `INSERT INTO tx_attempts
            (id, slot_id, chain_id, hash, raw_signed_tx, gas_limit,
             max_fee_per_gas, max_priority_fee_per_gas, reserved_cost_wei, budget_day)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (hash) DO NOTHING
           RETURNING *`,
          [
            randomUUID(), slot.id, String(this.config.chainId), hash, rawSignedTx,
            String(gasLimit), String(fee.maxFeePerGas), String(fee.maxPriorityFeePerGas),
            String(worstCost), today,
          ],
        );
        if (!attemptResult.rows[0]) return null;

        await tx.query(
          "UPDATE sponsor_budget SET reserved_wei = reserved_wei + $2, updated_at = now() WHERE chain_id = $1",
          [String(this.config.chainId), String(worstCost)],
        );
        await tx.query(
          `UPDATE claim_jobs
           SET status = 'SIGNED', tx_hashes = tx_hashes || $2::jsonb,
               error_code = NULL, blocked_reason = NULL, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [jobId, JSON.stringify([hash])],
        );
        return { rawSignedTx, hash };
      });
    } catch (error) {
      this.warn("claim_persist_failed", { jobId, error: safeError(error) });
      return false;
    }

    if (!signed) return false;
    await this.broadcastAttempt(signed);
    return true;
  }

  async preflight(job) {
    try {
      const [series, claimed] = await Promise.all([
        this.chain.getSeries(job.series_id),
        this.chain.getSerialClaimed(job.token_id),
      ]);
      if (claimed) {
        await this.reconcileExternalClaim(job);
        return { ok: false };
      }
      if (!series.open) {
        await this.markJob(job.id, "EXPIRED_UNSENT", { error_code: "SERIES_CLOSED" });
        return { ok: false };
      }
      if (series.minted >= series.maxSupply) {
        await this.markJob(job.id, "EXPIRED_UNSENT", { error_code: "MAX_SUPPLY_REACHED" });
        return { ok: false };
      }
      return { ok: true };
    } catch (error) {
      this.warn("claim_preflight_failed", { jobId: job.id, error: safeError(error) });
      return { ok: false };
    }
  }

  async broadcastAttempt({ rawSignedTx, hash }) {
    try {
      await this.chain.broadcast(rawSignedTx);
      await this.db.query(
        `UPDATE tx_attempts SET broadcast_at = now(), last_checked_at = now(), last_broadcast_error = NULL
         WHERE hash = $1`,
        [hash],
      );
      await this.db.query(
        `UPDATE claim_jobs SET status = 'PENDING', updated_at = now()
         WHERE id = (SELECT job_id FROM nonce_slots
                     WHERE id = (SELECT slot_id FROM tx_attempts WHERE hash = $1))`,
        [hash],
      );
      this.log("claim_broadcast", { txHash: hash });
    } catch (error) {
      await this.db.query(
        `UPDATE tx_attempts SET last_broadcast_error = $2, last_checked_at = now()
         WHERE hash = $1`,
        [hash, safeError(error)],
      ).catch(() => {});
      await this.db.query(
        `UPDATE claim_jobs SET status = 'BROADCAST_UNKNOWN', error_code = COALESCE(error_code, 'BROADCAST_UNKNOWN'), updated_at = now()
         WHERE id = (SELECT job_id FROM nonce_slots
                     WHERE id = (SELECT slot_id FROM tx_attempts WHERE hash = $1))`,
        [hash],
      ).catch(() => {});
      this.warn("claim_broadcast_unknown", { txHash: hash, error: safeError(error) });
    }
  }

  async recoverUnbroadcast(limit = 5) {
    const result = await this.db.query(
      `SELECT a.hash, a.raw_signed_tx
       FROM tx_attempts a
       JOIN nonce_slots s ON s.id = a.slot_id
       JOIN claim_jobs j ON j.id = s.job_id
       WHERE a.finalized_at IS NULL AND a.broadcast_at IS NULL
       ORDER BY a.created_at LIMIT $1`,
      [limit],
    );
    for (const attempt of result.rows) {
      await this.broadcastAttempt({
        rawSignedTx: attempt.raw_signed_tx,
        hash: attempt.hash,
      });
    }
    return result.rows.length;
  }

  async reconcileOpenJobs(limit = 10) {
    const result = await this.db.query(
      `SELECT DISTINCT j.id, j.updated_at
       FROM claim_jobs j
       LEFT JOIN nonce_slots s ON s.job_id = j.id AND s.finalized_at IS NULL
       WHERE j.status = ANY($1::text[]) OR s.id IS NOT NULL
       ORDER BY j.updated_at LIMIT $2`,
      [RECONCILE_STATUSES, limit],
    );
    let reconciled = 0;
    for (const row of result.rows) {
      try {
        await this.reconcileJob(row.id);
        reconciled += 1;
      } catch (error) {
        this.warn("claim_reconcile_failed", { jobId: row.id, error: safeError(error) });
      }
    }
    return reconciled;
  }

  async reconcileJob(jobId) {
    const loaded = await this.db.query("SELECT * FROM claim_jobs WHERE id = $1", [jobId]);
    const job = loaded.rows[0];
    if (!job) return;

    const attempts = await this.db.query(
      `SELECT a.* FROM tx_attempts a
       JOIN nonce_slots s ON s.id = a.slot_id
       WHERE s.job_id = $1 AND a.finalized_at IS NULL
       ORDER BY a.created_at`,
      [jobId],
    );

    if (attempts.rows.length === 0) {
      if (job.status === "MINED_SUCCESS") {
        await this.reconcileExternalClaim(job);
      } else if (!TERMINAL_BUSINESS.has(job.status)) {
        await this.reconcileExternalClaim(job);
      }
      return;
    }

    for (const attempt of attempts.rows) {
      let receipt = null;
      try {
        receipt = await this.chain.getTransactionReceipt(attempt.hash);
      } catch {
        continue;
      }
      if (receipt) {
        await this.applyReceipt(job, attempt, receipt);
        return;
      }
      if (!attempt.broadcast_at) {
        await this.broadcastAttempt({ rawSignedTx: attempt.raw_signed_tx, hash: attempt.hash });
        return;
      }
    }

    // No receipt yet. A third party may have submitted the same credential.
    await this.reconcileExternalClaim(job);
  }

  async applyReceipt(job, attempt, receipt) {
    let latest;
    try {
      latest = await this.chain.getBlockNumber();
      const block = await this.chain.getBlock(receipt.blockNumber);
      if (block?.hash && receipt.blockHash && block.hash !== receipt.blockHash) {
        await this.markJob(job.id, "NEEDS_RECONCILIATION", {
          error_code: "REORG_DETECTED",
          confirmations: 0,
        });
        return;
      }
    } catch {
      return;
    }

    const confirmations = Math.max(0, Number(latest) - Number(receipt.blockNumber) + 1);
    const required = Number(job.required_confirmations);
    const gasUsed = receipt.gasUsed ?? 0n;
    const effectiveGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
    const actualCost = gasUsed * effectiveGasPrice;

    if (receipt.status === 1) {
      const claimed = this.chain.parseClaimedReceipt(receipt);
      if (!claimed) {
        if (confirmations >= required) {
          await this.markJob(job.id, "NEEDS_RECONCILIATION", {
            error_code: "MISSING_CLAIMED_EVENT",
            confirmations,
          });
        }
        return;
      }
      const matches = String(claimed.recipient).toLowerCase() === job.recipient.toLowerCase();
      const status = matches
        ? (confirmations >= required ? "CONFIRMED" : "MINED_SUCCESS")
        : (confirmations >= required ? "CLAIM_CONFLICT" : "MINED_SUCCESS");
      const currentOwner = await this.chain.getOwner(claimed.tokenId).catch(() => claimed.recipient);
      await this.markJob(job.id, status, {
        confirmations,
        token_id: String(claimed.tokenId),
        minted_to_recipient: matches,
        current_owner: currentOwner,
        error_code: matches ? null : "CLAIM_CONFLICT",
      });
      if (confirmations >= required) {
        await this.finalizeSlot(attempt, receipt, actualCost);
      }
      return;
    }

    // A third party may already have completed this charm for our recipient.
    // Our later reverting transaction must not erase that successful claim.
    if (job.minted_to_recipient === true && ["MINED_SUCCESS", "CONFIRMED"].includes(job.status)) {
      if (confirmations >= required) await this.finalizeSlot(attempt, receipt, actualCost);
      return;
    }

    await this.markJob(job.id, "MINED_REVERTED", {
      confirmations,
      error_code: "MINED_REVERTED",
    });
    if (confirmations >= required) {
      await this.finalizeSlot(attempt, receipt, actualCost);
    }
  }

  async reconcileExternalClaim(job) {
    let claimed;
    try {
      claimed = await this.chain.findClaimed(job.token_id);
    } catch {
      return;
    }
    if (!claimed) return;

    let latest;
    try {
      latest = await this.chain.getBlockNumber();
    } catch {
      return;
    }
    const confirmations = Math.max(0, Number(latest) - Number(claimed.blockNumber) + 1);
    const required = Number(job.required_confirmations);
    const matches = String(claimed.recipient).toLowerCase() === job.recipient.toLowerCase();
    if (!matches && confirmations < required) return;

    const currentOwner = await this.chain.getOwner(claimed.tokenId).catch(() => claimed.recipient);
    const status = matches
      ? (confirmations >= required ? "CONFIRMED" : "MINED_SUCCESS")
      : "CLAIM_CONFLICT";
    const hashes = new Set(jsonArray(job.tx_hashes));
    hashes.add(claimed.txHash);
    await this.markJob(job.id, status, {
      confirmations,
      token_id: String(claimed.tokenId),
      minted_to_recipient: matches,
      current_owner: currentOwner,
      error_code: matches ? null : "CLAIM_CONFLICT",
      tx_hashes: [...hashes],
    });
  }

  async markJob(jobId, status, fields = {}) {
    const assignments = ["status = $2", "updated_at = now()"];
    const values = [jobId, status];
    let index = 3;
    const add = (column, value, cast = "") => {
      assignments.push(`${column} = $${index}${cast}`);
      values.push(value);
      index += 1;
    };
    if (fields.confirmations !== undefined) add("confirmations", fields.confirmations);
    if (fields.token_id !== undefined) add("token_id", fields.token_id);
    if (fields.minted_to_recipient !== undefined) add("minted_to_recipient", fields.minted_to_recipient);
    if (fields.current_owner !== undefined) add("current_owner", fields.current_owner);
    if (fields.error_code !== undefined) add("error_code", fields.error_code);
    if (fields.tx_hashes !== undefined) add("tx_hashes", JSON.stringify(fields.tx_hashes), "::jsonb");
    await this.db.query(
      `UPDATE claim_jobs SET ${assignments.join(", ")} WHERE id = $1`,
      values,
    );
  }

  async block(jobId, reason) {
    await this.db.query(
      "UPDATE claim_jobs SET blocked_reason = $2, updated_at = now() WHERE id = $1",
      [jobId, reason],
    );
  }

  async finalizeSlot(attempt, receipt, actualCost) {
    await this.db.transaction(async (tx) => {
      const slotAttempts = await tx.query(
        "SELECT * FROM tx_attempts WHERE slot_id = $1 AND finalized_at IS NULL FOR UPDATE",
        [attempt.slot_id],
      );
      const reserved = slotAttempts.rows.reduce((sum, row) => sum + BigInt(row.reserved_cost_wei), 0n);
      await tx.query(
        `UPDATE sponsor_budget
         SET reserved_wei = GREATEST(0, reserved_wei - $2),
             spent_wei = spent_wei + $3,
             updated_at = now()
         WHERE chain_id = $1`,
        [String(this.config.chainId), String(reserved), String(actualCost)],
      );
      await tx.query(
        `UPDATE tx_attempts
         SET receipt_status = $2, block_number = $3, block_hash = $4,
             gas_used = $5, effective_gas_price = $6, finalized_at = now(),
             last_checked_at = now()
         WHERE id = $1`,
        [
          attempt.id, receipt.status === 1 ? "success" : "reverted",
          receipt.blockNumber, receipt.blockHash, String(receipt.gasUsed ?? 0n),
          String(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n),
        ],
      );
      await tx.query(
        "UPDATE tx_attempts SET finalized_at = now() WHERE slot_id = $1 AND finalized_at IS NULL",
        [attempt.slot_id],
      );
      await tx.query(
        "UPDATE nonce_slots SET finalized_at = now() WHERE id = $1",
        [attempt.slot_id],
      );
    });
  }
}

export { claimArgs };
