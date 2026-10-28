CREATE TABLE IF NOT EXISTS claim_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL,
  contract_address TEXT NOT NULL,
  series_id NUMERIC(78, 0) NOT NULL,
  serial BIGINT NOT NULL,
  token_id NUMERIC(78, 0) NOT NULL,
  credential_signer TEXT NOT NULL,
  proof JSONB NOT NULL,
  recipient TEXT NOT NULL,
  deadline NUMERIC(78, 0) NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'SIGNED', 'PENDING', 'BROADCAST_UNKNOWN', 'MINED_SUCCESS',
    'MINED_REVERTED', 'CONFIRMED', 'EXPIRED_UNSENT', 'CLAIM_CONFLICT',
    'NEEDS_RECONCILIATION'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  tx_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL,
  minted_to_recipient BOOLEAN,
  current_owner TEXT,
  error_code TEXT,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, series_id, serial)
);

CREATE INDEX IF NOT EXISTS claim_jobs_account_idx
  ON claim_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS claim_jobs_status_idx
  ON claim_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id TEXT REFERENCES claim_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, key)
);

CREATE TABLE IF NOT EXISTS relayer_state (
  chain_id BIGINT NOT NULL,
  relayer_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, relayer_address)
);

CREATE TABLE IF NOT EXISTS nonce_slots (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  relayer_address TEXT NOT NULL,
  nonce BIGINT NOT NULL,
  job_id TEXT NOT NULL REFERENCES claim_jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  UNIQUE (chain_id, relayer_address, nonce)
);

CREATE UNIQUE INDEX IF NOT EXISTS nonce_slots_one_open_per_job
  ON nonce_slots (job_id) WHERE finalized_at IS NULL;

CREATE TABLE IF NOT EXISTS tx_attempts (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES nonce_slots(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  raw_signed_tx TEXT NOT NULL,
  gas_limit NUMERIC(78, 0) NOT NULL,
  max_fee_per_gas NUMERIC(78, 0) NOT NULL,
  max_priority_fee_per_gas NUMERIC(78, 0) NOT NULL,
  reserved_cost_wei NUMERIC(78, 0) NOT NULL,
  budget_day DATE NOT NULL,
  broadcast_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  receipt_status TEXT,
  block_number BIGINT,
  block_hash TEXT,
  gas_used NUMERIC(78, 0),
  effective_gas_price NUMERIC(78, 0),
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tx_attempts_slot_idx ON tx_attempts (slot_id);
CREATE INDEX IF NOT EXISTS tx_attempts_open_idx ON tx_attempts (finalized_at)
  WHERE finalized_at IS NULL;

CREATE TABLE IF NOT EXISTS sponsor_budget (
  chain_id BIGINT PRIMARY KEY,
  budget_day DATE NOT NULL,
  spent_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
  reserved_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
