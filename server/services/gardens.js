import { createHash, randomUUID } from "node:crypto";
import {
  CROPS,
  advanceGame,
  createGame,
  getGardenActionError,
  isGardenState,
  reduceGame,
} from "../../shared/garden-state.js";
import { AppError } from "../lib/errors.js";
import { syncAccount } from "./accounts.js";

const ACTION_TYPES = new Set(["buy", "plant", "harvest", "feed", "play"]);
const CROP_IDS = new Set(CROPS.map((crop) => crop.id));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenString(value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text) || BigInt(text) <= 0n) {
    throw new AppError("INVALID_TOKEN", "Token id must be a positive decimal integer.", 400);
  }
  return BigInt(text).toString();
}

function revisionString(value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new AppError("INVALID_REVISION", "expectedRevision must be a decimal integer.", 400);
  }
  return BigInt(text).toString();
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new AppError("ACTION_INVALID", "A garden action is required.", 400);
  }
  if (!ACTION_TYPES.has(action.type)) {
    throw new AppError("ACTION_INVALID", "That garden action is not supported.", 400);
  }
  const allowed = action.type === "buy" || action.type === "plant"
    ? new Set(["type", "cropId", "plotIndex"])
    : action.type === "harvest"
      ? new Set(["type", "plotIndex"])
      : new Set(["type"]);
  for (const key of Object.keys(action)) {
    if (!allowed.has(key)) {
      throw new AppError("ACTION_INVALID", `Unexpected action field: ${key}`, 400);
    }
  }
  if (action.type === "buy" || action.type === "plant") {
    if (!CROP_IDS.has(action.cropId)) {
      throw new AppError("ACTION_INVALID", "Choose a valid crop.", 400);
    }
  }
  if (action.type === "plant" || action.type === "harvest") {
    if (!Number.isInteger(action.plotIndex) || action.plotIndex < 0 || action.plotIndex > 2) {
      throw new AppError("ACTION_INVALID", "Choose a valid garden plot.", 400);
    }
  }
  return action;
}

function payloadHash(action) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function parseState(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function invalidState() {
  return new AppError(
    "GARDEN_STATE_INVALID",
    "The saved garden could not be read safely. Support has been notified; the record was preserved.",
    500,
  );
}

export function createGardenService({ db, chain, config, clock = Date.now }) {
  function display(garden, now) {
    const state = parseState(garden.state);
    if (!isGardenState(state)) throw invalidState();
    return {
      state: advanceGame(state, now),
      revision: String(garden.revision),
      rulesVersion: garden.rules_version,
      serverTime: new Date(now).toISOString(),
    };
  }

  async function ownership(identity, tokenId) {
    const { account, wallet } = await syncAccount(db, identity, {
      chainId: config.chainId, bindingVersion: config.walletBindingVersion,
    });
    let snapshot;
    try {
      snapshot = await chain.getOwnerSnapshot(tokenId);
    } catch {
      throw new AppError("CHAIN_UNAVAILABLE", "Ownership could not be checked right now.", 503);
    }
    if (String(snapshot.owner).toLowerCase() !== wallet.normalizedAddress) {
      throw new AppError("NOT_OWNER", "This pet belongs to a different wallet.", 403);
    }
    return { account, wallet, snapshot };
  }

  async function ensureGarden(tx, { accountId, tokenId, now, snapshot }) {
    const existing = await tx.query(
      `SELECT * FROM gardens
       WHERE account_id = $1 AND chain_id = $2 AND contract_address = $3 AND token_id = $4
       FOR UPDATE`,
      [accountId, String(config.chainId), config.contractAddress, tokenId],
    );
    if (existing.rows[0]) return existing.rows[0];

    const initialState = createGame(now);
    const inserted = await tx.query(
      `INSERT INTO gardens
        (id, account_id, chain_id, contract_address, token_id, schema_version,
         rules_version, state, revision, owner_block_number, owner_block_hash,
         ownership_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 0, $9, $10, now())
       ON CONFLICT (account_id, chain_id, contract_address, token_id) DO NOTHING
       RETURNING *`,
      [
        randomUUID(), accountId, String(config.chainId), config.contractAddress, tokenId,
        initialState.version, config.gardenRulesVersion, JSON.stringify(initialState),
        snapshot?.blockNumber ?? null, snapshot?.blockHash ?? null,
      ],
    );
    if (inserted.rows[0]) return inserted.rows[0];

    const again = await tx.query(
      `SELECT * FROM gardens
       WHERE account_id = $1 AND chain_id = $2 AND contract_address = $3 AND token_id = $4
       FOR UPDATE`,
      [accountId, String(config.chainId), config.contractAddress, tokenId],
    );
    if (!again.rows[0]) throw invalidState();
    return again.rows[0];
  }

  async function get(identity, rawTokenId) {
    const tokenId = tokenString(rawTokenId);
    const { account, snapshot } = await ownership(identity, tokenId);
    const now = clock();
    const row = await db.transaction(async (tx) => ensureGarden(tx, {
      accountId: account.accountId, tokenId, now, snapshot,
    }));
    if (row.rules_version !== config.gardenRulesVersion) {
      throw new AppError(
        "RULES_VERSION_MISMATCH",
        "This garden was saved with a different care rules version.",
        409,
      );
    }
    return display(row, now);
  }

  async function action(identity, rawTokenId, body) {
    const tokenId = tokenString(rawTokenId);
    const actionId = String(body?.actionId ?? "");
    if (!UUID.test(actionId)) {
      throw new AppError("INVALID_REQUEST", "actionId must be a UUID.", 400);
    }
    const expectedRevision = revisionString(body?.expectedRevision);
    const action = validateAction(body?.action);
    const { account, snapshot } = await ownership(identity, tokenId);
    const hash = payloadHash(action);
    const now = clock();

    const response = await db.transaction(async (tx) => {
      const garden = await ensureGarden(tx, {
        accountId: account.accountId, tokenId, now, snapshot,
      });
      const state = parseState(garden.state);
      if (!isGardenState(state)) throw invalidState();
      if (garden.rules_version !== config.gardenRulesVersion) {
        throw new AppError(
          "RULES_VERSION_MISMATCH",
          "This garden was saved with a different care rules version.",
          409,
        );
      }

      const duplicate = await tx.query(
        "SELECT * FROM garden_actions WHERE garden_id = $1 AND action_id = $2",
        [garden.id, actionId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].payload_hash !== hash) {
          throw new AppError(
            "ACTION_ID_CONFLICT",
            "This action id was already used for a different action.",
            409,
          );
        }
        return duplicate.rows[0].response;
      }

      if (String(garden.revision) !== expectedRevision) {
        throw new AppError(
          "REVISION_CONFLICT",
          "The garden changed on another device. The latest state has been loaded.",
          409,
          display(garden, now),
        );
      }

      const serverNow = Math.max(now, state.lastUpdated);
      const current = advanceGame(state, serverNow);
      const reason = getGardenActionError(current, action, serverNow);
      if (reason) throw new AppError("ACTION_INVALID", reason, 400);
      const next = reduceGame(current, action, serverNow);
      if (next === current) throw new AppError("ACTION_INVALID", "That action is not available.", 400);

      const revision = String(BigInt(garden.revision) + 1n);
      const result = {
        state: next,
        revision,
        rulesVersion: config.gardenRulesVersion,
        serverTime: new Date(serverNow).toISOString(),
        actionId,
      };

      await tx.query(
        `UPDATE gardens
         SET state = $2::jsonb, revision = $3, owner_block_number = $4,
             owner_block_hash = $5, ownership_checked_at = now(), updated_at = now()
         WHERE id = $1`,
        [
          garden.id, JSON.stringify(next), revision,
          snapshot.blockNumber ?? null, snapshot.blockHash ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO garden_actions (id, garden_id, action_id, payload_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (garden_id, action_id) DO NOTHING`,
        [randomUUID(), garden.id, actionId, hash, JSON.stringify(result)],
      );
      return result;
    });

    return response;
  }

  return { get, action, ownership };
}
