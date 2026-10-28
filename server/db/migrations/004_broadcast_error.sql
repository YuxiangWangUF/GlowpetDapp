ALTER TABLE tx_attempts
  ADD COLUMN IF NOT EXISTS last_broadcast_error TEXT;
