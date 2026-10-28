CREATE TABLE IF NOT EXISTS gardens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id NUMERIC(78, 0) NOT NULL,
  schema_version INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  state JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  owner_block_number BIGINT,
  owner_block_hash TEXT,
  ownership_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, chain_id, contract_address, token_id)
);

CREATE TABLE IF NOT EXISTS garden_actions (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (garden_id, action_id)
);
