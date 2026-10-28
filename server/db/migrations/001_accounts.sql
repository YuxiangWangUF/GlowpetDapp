CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS wallet_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL,
  provider_wallet_id TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  verification_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, chain_id)
);

CREATE INDEX IF NOT EXISTS wallet_bindings_address_idx
  ON wallet_bindings (chain_id, normalized_address);
