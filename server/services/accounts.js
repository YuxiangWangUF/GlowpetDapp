import { randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { AppError } from "../lib/errors.js";

function normalizeAddress(value) {
  return getAddress(value).toLowerCase();
}

function mapAccount(row) {
  return {
    accountId: row.id,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email ?? "",
    createdAt: row.created_at,
  };
}

/**
 * Bind an authenticated provider identity to exactly one wallet per chain.
 * The address in the request body is never used here: identity.walletId and
 * identity.address come from the verified provider response.
 */
export async function syncAccount(db, identity, { chainId, bindingVersion = 1 }) {
  const normalized = normalizeAddress(identity.address);

  const accountResult = await db.query(
    `INSERT INTO accounts (id, issuer, subject, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issuer, subject)
     DO UPDATE SET email = COALESCE(EXCLUDED.email, accounts.email), updated_at = now()
     RETURNING *`,
    [randomUUID(), identity.issuer, identity.subject, identity.email || null],
  );
  const account = accountResult.rows[0];

  const insertResult = await db.query(
    `INSERT INTO wallet_bindings
       (id, account_id, chain_id, provider_wallet_id, normalized_address, verification_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, chain_id) DO NOTHING
     RETURNING *`,
    [randomUUID(), account.id, String(chainId), identity.walletId, normalized, bindingVersion],
  );

  let binding = insertResult.rows[0];
  if (!binding) {
    const existing = await db.query(
      "SELECT * FROM wallet_bindings WHERE account_id = $1 AND chain_id = $2",
      [account.id, String(chainId)],
    );
    binding = existing.rows[0];
  }
  if (!binding) {
    throw new AppError("WALLET_NOT_READY", "Your wallet binding is not ready yet.", 409);
  }
  if (binding.normalized_address !== normalized) {
    throw new AppError(
      "WALLET_CHANGED",
      "This account is already bound to a different Glowpet wallet. Contact support before using another wallet.",
      409,
    );
  }

  if (binding.provider_wallet_id !== identity.walletId || binding.verification_version !== bindingVersion) {
    await db.query(
      `UPDATE wallet_bindings
       SET provider_wallet_id = $2, verification_version = $3, updated_at = now()
       WHERE id = $1`,
      [binding.id, identity.walletId, bindingVersion],
    );
  }

  return {
    account: mapAccount(account),
    wallet: {
      address: getAddress(binding.normalized_address),
      normalizedAddress: binding.normalized_address,
      providerWalletId: binding.provider_wallet_id,
      kind: "embedded_eoa",
    },
  };
}

export async function getWalletBinding(db, accountId, chainId) {
  const result = await db.query(
    "SELECT * FROM wallet_bindings WHERE account_id = $1 AND chain_id = $2",
    [accountId, String(chainId)],
  );
  const binding = result.rows[0];
  if (!binding) {
    throw new AppError("WALLET_NOT_READY", "Your Glowpet wallet is not ready yet.", 409);
  }
  return {
    address: getAddress(binding.normalized_address),
    normalizedAddress: binding.normalized_address,
    providerWalletId: binding.provider_wallet_id,
    kind: "embedded_eoa",
  };
}
