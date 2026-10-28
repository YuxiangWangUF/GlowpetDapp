import { createHash, randomUUID } from "node:crypto";
import { getAddress, isAddress, isHexString } from "ethers";
import {
  CLAIM_PROTOCOL_VERSION,
  normalizeAddress,
  normalizeBytes32,
  verifyClaimAuthorization,
  verifyClaimProof,
} from "../../shared/claim-protocol.js";
import { AppError } from "../lib/errors.js";
import { syncAccount } from "./accounts.js";

const ACTIVE_STATUSES = [
  "QUEUED", "SIGNED", "PENDING", "BROADCAST_UNKNOWN", "MINED_SUCCESS", "MINED_REVERTED",
];
const TERMINAL_STATUSES = ["CONFIRMED", "CLAIM_CONFLICT", "EXPIRED_UNSENT", "NEEDS_RECONCILIATION"];
const UINT32_MAX = 0xffff_ffffn;
const SERIES_STRIDE = 1_000_000n;

function asDigits(value, label, { min = 0n, max = null } = {}) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) throw new AppError("INVALID_REQUEST", `${label} must be a decimal integer.`, 400);
  const parsed = BigInt(text);
  if (parsed < min || (max !== null && parsed > max)) {
    throw new AppError("INVALID_REQUEST", `${label} is outside the supported range.`, 400);
  }
  return parsed;
}

function serialFromBody(value) {
  if (!Number.isInteger(value) || value < 1 || BigInt(value) > UINT32_MAX) {
    throw new AppError("INVALID_SERIAL", "Serial must be an integer between 1 and 4294967295.", 400);
  }
  return value;
}

function normalizeProof(proof) {
  if (!Array.isArray(proof) || proof.length > 64) {
    throw new AppError("INVALID_PROOF", "Proof must be an array of at most 64 hashes.", 400);
  }
  try {
    return proof.map((node) => normalizeBytes32(node, "Proof node"));
  } catch (error) {
    throw new AppError("INVALID_PROOF", error.message, 400);
  }
}

function normalizeSignature(value) {
  if (typeof value !== "string" || !isHexString(value)) {
    throw new AppError("INVALID_SIGNATURE", "Claim signature is not valid hex.", 400);
  }
  return value.toLowerCase();
}

function canonicalRequest(body) {
  return JSON.stringify({
    seriesId: String(body.seriesId),
    serial: body.serial,
    credentialSigner: getAddress(body.credentialSigner),
    proof: [...body.proof],
    recipient: getAddress(body.recipient),
    deadline: String(body.deadline),
    signature: body.signature.toLowerCase(),
  });
}

function requestHash(body) {
  return createHash("sha256").update(canonicalRequest(body)).digest("hex");
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

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

export function mapJob(row) {
  const txHashes = jsonArray(row.tx_hashes);
  return {
    jobId: row.id,
    status: row.status,
    seriesId: String(row.series_id),
    serial: Number(row.serial),
    tokenId: String(row.token_id),
    recipient: getAddress(row.recipient),
    txHashes,
    txHash: txHashes[0] ?? null,
    confirmations: Number(row.confirmations ?? 0),
    requiredConfirmations: Number(row.required_confirmations ?? 0),
    mintedToRecipient: row.minted_to_recipient ?? null,
    currentOwner: row.current_owner ?? null,
    errorCode: row.error_code ?? null,
    blockedReason: row.blocked_reason ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pollAfterMs: TERMINAL_STATUSES.includes(row.status) ? 0 : 2500,
  };
}

async function findJobBySerial(db, { chainId, contractAddress, seriesId, serial }) {
  const result = await db.query(
    `SELECT * FROM claim_jobs
     WHERE chain_id = $1 AND contract_address = $2 AND series_id = $3 AND serial = $4`,
    [String(chainId), contractAddress, String(seriesId), serial],
  );
  return result.rows[0] ?? null;
}

async function findIdempotency(db, accountId, key) {
  const result = await db.query(
    "SELECT * FROM idempotency_keys WHERE account_id = $1 AND key = $2",
    [accountId, key],
  );
  return result.rows[0] ?? null;
}

async function budgetAvailable(db, chainId, dailyBudgetWei) {
  const result = await db.query("SELECT * FROM sponsor_budget WHERE chain_id = $1", [String(chainId)]);
  const row = result.rows[0];
  if (!row) return dailyBudgetWei;
  return dailyBudgetWei - BigInt(row.spent_wei) - BigInt(row.reserved_wei);
}

function assertSponsorAvailable(config, worstCost, available) {
  if (config.sponsorPaused) {
    throw new AppError(
      "SPONSOR_PAUSED",
      "Sponsored claims are paused right now. Your charm is safe; use an existing wallet or try again later.",
      503,
    );
  }
  if (worstCost > available) {
    throw new AppError(
      "BUDGET_EXHAUSTED",
      "Today's sponsored-claim budget is exhausted. Try again later or use an existing wallet.",
      503,
    );
  }
}

function validateAuthorization({ body, chainId, contractAddress, recipient, now, maxTtlSeconds }) {
  const seriesId = asDigits(body.seriesId, "seriesId", { min: 1n });
  const serial = serialFromBody(body.serial);
  const deadline = asDigits(body.deadline, "deadline", { min: 1n });
  let credentialSigner;
  try {
    credentialSigner = normalizeAddress(body.credentialSigner, "Credential signer");
  } catch (error) {
    throw new AppError("INVALID_SIGNATURE", error.message, 400);
  }
  let normalizedRecipient;
  try {
    normalizedRecipient = normalizeAddress(recipient, "Recipient");
  } catch (error) {
    throw new AppError("RECIPIENT_MISMATCH", error.message, 400);
  }

  const nowSeconds = BigInt(Math.floor(now / 1000));
  if (deadline <= nowSeconds) {
    throw new AppError("AUTHORIZATION_EXPIRED", "This claim authorization expired. Sign the charm again.", 400);
  }
  if (deadline > nowSeconds + BigInt(maxTtlSeconds)) {
    throw new AppError(
      "AUTHORIZATION_EXPIRED",
      "This claim authorization is valid for too long. Sign the charm again.",
      400,
    );
  }

  let signature;
  try {
    signature = normalizeSignature(body.signature);
    verifyClaimAuthorization({
      chainId,
      verifyingContract: contractAddress,
      seriesId,
      serial,
      credentialSigner,
      recipient: normalizedRecipient,
      deadline,
      signature,
    });
  } catch (error) {
    throw new AppError("INVALID_SIGNATURE", error.message, 400);
  }

  return {
    seriesId,
    serial,
    credentialSigner,
    recipient: normalizedRecipient,
    deadline,
    signature,
    proof: normalizeProof(body.proof),
  };
}

async function readChainContract(chain, config) {
  try {
    const [chainId, code, protocol] = await Promise.all([
      chain.getChainId(),
      chain.getCode(),
      chain.getProtocolVersion(),
    ]);
    if (Number(chainId) !== Number(config.chainId)) {
      throw new AppError("CHAIN_UNAVAILABLE", "The server RPC is connected to a different chain.", 503);
    }
    if (code === "0x") {
      throw new AppError("CHAIN_UNAVAILABLE", "No Glowpet contract exists at the configured address.", 503);
    }
    if (Number(protocol) !== CLAIM_PROTOCOL_VERSION) {
      throw new AppError("UNSUPPORTED_PROTOCOL", "The deployed contract is not Glowpet v2.", 409);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CHAIN_UNAVAILABLE", "The Glowpet network is unavailable. Try again shortly.", 503);
  }
}

function assertSeries(series, args, config) {
  if (!config.allowedSeriesIds.has(String(args.seriesId))) {
    throw new AppError("SERIES_NOT_ALLOWED", "This series is not enabled for sponsored claims.", 400);
  }
  if (!series.open) {
    throw new AppError("SERIES_CLOSED", "This series is closed and no longer accepting claims.", 409);
  }
  if (BigInt(args.serial) > BigInt(series.maxSupply)) {
    throw new AppError("INVALID_SERIAL", "That serial is outside this series.", 400);
  }
  if (BigInt(series.minted) >= BigInt(series.maxSupply)) {
    throw new AppError("MAX_SUPPLY_REACHED", "Every charm in this series has been claimed.", 409);
  }
}

function verifyProofAgainstSeries(series, args, chainId, contractAddress) {
  let valid = false;
  try {
    valid = verifyClaimProof({
      proof: args.proof,
      root: series.root,
      chainId,
      seriesId: args.seriesId,
      serial: args.serial,
      credentialSigner: args.credentialSigner,
    });
  } catch (error) {
    throw new AppError("INVALID_PROOF", error.message, 400);
  }
  if (!valid) {
    throw new AppError("INVALID_PROOF", "This credential is not valid for that serial in this series.", 400);
  }
}

function tokenIdFor(seriesId, serial) {
  return BigInt(seriesId) * SERIES_STRIDE + BigInt(serial);
}

async function insertJob(tx, { identity, config, args, tokenId }) {
  const jobId = randomUUID();
  const result = await tx.query(
    `INSERT INTO claim_jobs
      (id, account_id, chain_id, contract_address, series_id, serial, token_id,
       credential_signer, proof, recipient, deadline, signature, status,
       required_confirmations)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 'QUEUED', $13)
     ON CONFLICT (chain_id, contract_address, series_id, serial) DO NOTHING
     RETURNING *`,
    [
      jobId, identity.accountId, String(config.chainId), config.contractAddress,
      String(args.seriesId), args.serial, String(tokenId),
      args.credentialSigner, JSON.stringify(args.proof), args.recipient,
      String(args.deadline), args.signature, config.claimConfirmations,
    ],
  );
  return { jobId, job: result.rows[0] ?? null };
}

async function insertIdempotency(tx, { accountId, key, hash, jobId }) {
  await tx.query(
    `INSERT INTO idempotency_keys (id, account_id, key, request_hash, job_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, key) DO NOTHING`,
    [randomUUID(), accountId, key, hash, jobId],
  );
  const stored = await tx.query(
    "SELECT * FROM idempotency_keys WHERE account_id = $1 AND key = $2",
    [accountId, key],
  );
  const row = stored.rows[0];
  if (!row) throw new AppError("INTERNAL_ERROR", "The idempotency record could not be saved.", 500);
  if (row.request_hash !== hash) {
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for a different claim. Start a new claim.",
      409,
    );
  }
  return row;
}

export function createClaimService({ db, chain, config, clock = Date.now, rateLimiter = null }) {
  async function submit(identity, body, idempotencyKey) {
    if (!idempotencyKey) {
      throw new AppError("INVALID_REQUEST", "Idempotency-Key is required.", 400);
    }
    if (rateLimiter) rateLimiter.consume(identity.accountId ?? identity.subject);

    const { account, wallet } = await syncAccount(db, identity, {
      chainId: config.chainId,
      bindingVersion: config.walletBindingVersion,
    });
    identity.accountId = account.accountId;

    if (String(body.recipient).toLowerCase() !== wallet.address.toLowerCase()) {
      throw new AppError(
        "RECIPIENT_MISMATCH",
        "The claim must be sent to the wallet verified for this account.",
        400,
      );
    }

    const now = clock();
    const args = validateAuthorization({
      body,
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      recipient: wallet.address,
      now,
      maxTtlSeconds: config.claimAuthMaxTtlSeconds,
    });
    const hash = requestHash({ ...body, ...args });

    const previousKey = await findIdempotency(db, account.accountId, idempotencyKey);
    if (previousKey) {
      if (previousKey.request_hash !== hash) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This request key was already used for a different claim. Start a new claim.",
          409,
        );
      }
      if (previousKey.job_id) {
        const existing = await db.query("SELECT * FROM claim_jobs WHERE id = $1", [previousKey.job_id]);
        if (existing.rows[0]) return mapJob(existing.rows[0]);
      }
    }

    const existing = await findJobBySerial(db, {
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      seriesId: args.seriesId,
      serial: args.serial,
    });
    if (existing) {
      if (existing.account_id === account.accountId && existing.recipient.toLowerCase() === wallet.normalizedAddress) {
        return mapJob(existing);
      }
      throw new AppError(
        "CLAIM_CONFLICT",
        "This charm is already being claimed by another account.",
        409,
      );
    }

    await readChainContract(chain, config);

    let series;
    try {
      series = await chain.getSeries(args.seriesId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CHAIN_UNAVAILABLE", "The series could not be read from the chain.", 503);
    }
    assertSeries(series, args, config);
    verifyProofAgainstSeries(series, args, config.chainId, config.contractAddress);

    let claimedTokenId = tokenIdFor(args.seriesId, args.serial);
    let serialClaimed = false;
    try {
      serialClaimed = await chain.getSerialClaimed(claimedTokenId);
    } catch {
      throw new AppError("CHAIN_UNAVAILABLE", "The claim status could not be read from the chain.", 503);
    }

    if (serialClaimed) {
      let event = null;
      try {
        event = await chain.findClaimed(claimedTokenId);
      } catch {
        throw new AppError("CHAIN_UNAVAILABLE", "The existing claim could not be verified.", 503);
      }
      if (!event) {
        throw new AppError(
          "ALREADY_CLAIMED",
          "This charm has already been activated. Open My Pets or scan the charm again after the claim confirms.",
          409,
        );
      }
      if (event.recipient.toLowerCase() !== wallet.normalizedAddress) {
        throw new AppError(
          "CLAIM_CONFLICT",
          "This charm was activated to a different wallet.",
          409,
        );
      }
      serialClaimed = true;
      return recordAlreadyClaimed({
        identity: account, wallet, args, event, claimedTokenId, idempotencyKey, hash,
      });
    }

    if (config.sponsorPaused) {
      throw new AppError(
        "SPONSOR_PAUSED",
        "Sponsored claims are paused right now. Your charm is safe; use an existing wallet or try again later.",
        503,
      );
    }

    let fee;
    let gasLimit;
    try {
      fee = await chain.getFeeData();
    } catch {
      throw new AppError("CHAIN_UNAVAILABLE", "The network fee could not be read.", 503);
    }
    if (fee.maxFeePerGas > config.maxFeePerGasWei) {
      throw new AppError(
        "SPONSOR_PAUSED",
        "The network fee is above the sponsor's safety limit. Try again later.",
        503,
      );
    }
    try {
      gasLimit = await chain.estimateClaimGas({
        ...args,
        seriesId: args.seriesId,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "SIMULATION_FAILED",
        "The claim could not be verified by the network. It will not consume gas.",
        400,
      );
    }
    if (gasLimit > config.maxGasPerTx) {
      throw new AppError(
        "SPONSOR_PAUSED",
        "This claim exceeds the sponsor's per-transaction gas limit.",
        503,
      );
    }
    const worstCost = gasLimit * fee.maxFeePerGas;
    const available = await budgetAvailable(db, config.chainId, config.dailyBudgetWei);
    assertSponsorAvailable(config, worstCost, available);

    try {
      const balance = await chain.getBalance(config.relayerAddress);
      if (balance < worstCost) {
        throw new AppError(
          "SPONSOR_PAUSED",
          "The sponsor wallet is low on testnet ETH. Try again later or use an existing wallet.",
          503,
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CHAIN_UNAVAILABLE", "The sponsor balance could not be checked.", 503);
    }

    const created = await db.transaction(async (tx) => {
      const key = await insertIdempotency(tx, {
        accountId: account.accountId, key: idempotencyKey, hash, jobId: null,
      });
      if (key.job_id) {
        const existingJob = await tx.query("SELECT * FROM claim_jobs WHERE id = $1", [key.job_id]);
        if (existingJob.rows[0]) return existingJob.rows[0];
      }

      const inserted = await insertJob(tx, {
        identity: account, config, args, tokenId: claimedTokenId,
      });
      if (inserted.job) {
        await tx.query(
          "UPDATE idempotency_keys SET job_id = $1 WHERE account_id = $2 AND key = $3",
          [inserted.jobId, account.accountId, idempotencyKey],
        );
        return inserted.job;
      }

      const concurrent = await tx.query(
        `SELECT * FROM claim_jobs
         WHERE chain_id = $1 AND contract_address = $2 AND series_id = $3 AND serial = $4
         FOR UPDATE`,
        [String(config.chainId), config.contractAddress, String(args.seriesId), args.serial],
      );
      const job = concurrent.rows[0];
      if (!job) throw new AppError("INTERNAL_ERROR", "The claim job could not be created.", 500);
      if (job.account_id !== account.accountId || job.recipient.toLowerCase() !== wallet.normalizedAddress) {
        throw new AppError("CLAIM_CONFLICT", "This charm is already being claimed by another account.", 409);
      }
      await tx.query(
        "UPDATE idempotency_keys SET job_id = $1 WHERE account_id = $2 AND key = $3",
        [job.id, account.accountId, idempotencyKey],
      );
      return job;
    });

    return mapJob(created);
  }

  async function recordAlreadyClaimed({
    identity, wallet, args, event, claimedTokenId, idempotencyKey, hash,
  }) {
    if (event.recipient.toLowerCase() !== wallet.normalizedAddress) {
      throw new AppError("CLAIM_CONFLICT", "This charm was activated to a different wallet.", 409);
    }
    const currentOwner = await chain.getOwner(event.tokenId).catch(() => event.recipient);
    let latestBlock = Number(event.blockNumber);
    try {
      latestBlock = await chain.getBlockNumber();
    } catch {
      // The event itself is still evidence; the worker will confirm later.
    }
    const confirmations = Math.max(1, Number(latestBlock) - Number(event.blockNumber) + 1);
    const confirmed = confirmations >= Number(config.claimConfirmations);
    const job = await db.transaction(async (tx) => {
      await insertIdempotency(tx, {
        accountId: identity.accountId, key: idempotencyKey, hash, jobId: null,
      });

      const existing = await tx.query(
        `SELECT * FROM claim_jobs
         WHERE chain_id = $1 AND contract_address = $2 AND series_id = $3 AND serial = $4`,
        [String(config.chainId), config.contractAddress, String(args.seriesId), args.serial],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].account_id !== identity.accountId) {
          throw new AppError("CLAIM_CONFLICT", "This charm was activated to a different wallet.", 409);
        }
        await tx.query(
          "UPDATE idempotency_keys SET job_id = $1 WHERE account_id = $2 AND key = $3",
          [existing.rows[0].id, identity.accountId, idempotencyKey],
        );
        return existing.rows[0];
      }

      const id = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO claim_jobs
          (id, account_id, chain_id, contract_address, series_id, serial, token_id,
           credential_signer, proof, recipient, deadline, signature, status,
           tx_hashes, confirmations, required_confirmations, minted_to_recipient,
           current_owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
                 $13, $14::jsonb, $15, $16, true, $17)
         ON CONFLICT (chain_id, contract_address, series_id, serial) DO NOTHING
         RETURNING *`,
        [
          id, identity.accountId, String(config.chainId), config.contractAddress,
          String(args.seriesId), args.serial, String(claimedTokenId), args.credentialSigner,
          JSON.stringify(args.proof), args.recipient, String(args.deadline), args.signature,
          confirmed ? "CONFIRMED" : "MINED_SUCCESS", JSON.stringify([event.txHash]),
          confirmations, config.claimConfirmations, currentOwner,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new AppError("CLAIM_CONFLICT", "This charm was already recorded by another account.", 409);
      }
      await tx.query(
        "UPDATE idempotency_keys SET job_id = $1 WHERE account_id = $2 AND key = $3",
        [row.id, identity.accountId, idempotencyKey],
      );
      return row;
    });
    return mapJob(job);
  }

  async function get(identity, jobId) {
    const account = await syncAccount(db, identity, {
      chainId: config.chainId, bindingVersion: config.walletBindingVersion,
    });
    const result = await db.query(
      "SELECT * FROM claim_jobs WHERE id = $1 AND account_id = $2",
      [jobId, account.account.accountId],
    );
    if (!result.rows[0]) throw new AppError("NOT_FOUND", "That claim was not found.", 404);
    return mapJob(result.rows[0]);
  }

  async function list(identity, { status = "active", limit = 20, offset = 0 } = {}) {
    const account = await syncAccount(db, identity, {
      chainId: config.chainId, bindingVersion: config.walletBindingVersion,
    });
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const filter = status === "active"
      ? `AND status = ANY($4::text[])`
      : status === "terminal"
        ? `AND status = ANY($4::text[])`
        : "";
    const statuses = status === "active" ? ACTIVE_STATUSES : TERMINAL_STATUSES;
    const result = await db.query(
      `SELECT * FROM claim_jobs WHERE account_id = $1 ${filter}
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      status === "all"
        ? [account.account.accountId, safeLimit, safeOffset]
        : [account.account.accountId, safeLimit, safeOffset, statuses],
    );
    return { jobs: result.rows.map(mapJob) };
  }

  async function updateAuthorization(identity, jobId, body, idempotencyKey) {
    if (!idempotencyKey) throw new AppError("INVALID_REQUEST", "Idempotency-Key is required.", 400);
    const { account, wallet } = await syncAccount(db, identity, {
      chainId: config.chainId, bindingVersion: config.walletBindingVersion,
    });
    const hash = createHash("sha256").update(JSON.stringify({
      jobId, deadline: String(body.deadline), signature: String(body.signature).toLowerCase(),
    })).digest("hex");

    const existingKey = await findIdempotency(db, account.accountId, idempotencyKey);
    if (existingKey) {
      if (existingKey.request_hash !== hash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "This request key was used for a different update.", 409);
      }
      if (existingKey.job_id === jobId) {
        const current = await db.query("SELECT * FROM claim_jobs WHERE id = $1 AND account_id = $2", [jobId, account.accountId]);
        if (current.rows[0]) return mapJob(current.rows[0]);
      }
    }

    await db.transaction(async (tx) => {
      const locked = await tx.query(
        "SELECT * FROM claim_jobs WHERE id = $1 AND account_id = $2 FOR UPDATE",
        [jobId, account.accountId],
      );
      const job = locked.rows[0];
      if (!job) throw new AppError("NOT_FOUND", "That claim was not found.", 404);
      if (job.recipient.toLowerCase() !== wallet.normalizedAddress) {
        throw new AppError("RECIPIENT_MISMATCH", "This claim belongs to another wallet.", 409);
      }
      if (!["QUEUED", "EXPIRED_UNSENT", "MINED_REVERTED"].includes(job.status)) {
        throw new AppError(
          "CLAIM_CONFLICT",
          "This claim has already been signed or has an unresolved transaction. It cannot be re-authorized automatically.",
          409,
        );
      }
      const openSlots = await tx.query(
        `SELECT s.id FROM nonce_slots s
         WHERE s.job_id = $1 AND s.finalized_at IS NULL LIMIT 1`,
        [jobId],
      );
      if (openSlots.rows[0]) {
        throw new AppError(
          "CLAIM_CONFLICT",
          "A transaction for this claim may still be in flight. It cannot be re-authorized yet.",
          409,
        );
      }

      const now = clock();
      const args = validateAuthorization({
        body: {
          ...job,
          ...body,
          seriesId: job.series_id,
          serial: Number(job.serial),
          credentialSigner: job.credential_signer,
          proof: jsonArray(job.proof),
        },
        chainId: config.chainId,
        contractAddress: config.contractAddress,
        recipient: job.recipient,
        now,
        maxTtlSeconds: config.claimAuthMaxTtlSeconds,
      });
      await insertIdempotency(tx, {
        accountId: account.accountId, key: idempotencyKey, hash, jobId,
      });
      await tx.query(
        `UPDATE claim_jobs
         SET deadline = $2, signature = $3, status = 'QUEUED', error_code = NULL,
             blocked_reason = NULL, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [jobId, String(args.deadline), args.signature],
      );
    });

    const updated = await db.query(
      "SELECT * FROM claim_jobs WHERE id = $1 AND account_id = $2",
      [jobId, account.accountId],
    );
    return mapJob(updated.rows[0]);
  }

  return { submit, get, list, updateAuthorization };
}
