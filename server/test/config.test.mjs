import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { createAccountRateLimiter } from "../services/rate-limit.js";

const BASE = {
  NODE_ENV: "test",
  AUTH_MODE: "mock",
  DATABASE_URL: "pglite:memory",
  CHAIN_ID: "11155111",
  RPC_URL: "http://127.0.0.1:8545",
  GLOWPET_ADDRESS: "0x0000000000000000000000000000000000001234",
  ALLOWED_SERIES_IDS: "1",
};

test("production rejects the mock identity provider", () => {
  assert.throws(
    () => loadConfig({ ...BASE, NODE_ENV: "production" }),
    /AUTH_MODE=mock is not allowed/,
  );
});

test("production requires real Privy credentials", () => {
  assert.throws(
    () => loadConfig({ ...BASE, NODE_ENV: "production", AUTH_MODE: "privy" }),
    /requires PRIVY_APP_ID and PRIVY_APP_SECRET/,
  );
});

test("an enabled relayer requires explicit fee and budget limits", () => {
  assert.throws(
    () => loadConfig({
      ...BASE,
      RELAYER_ENABLED: "true",
      RELAYER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    }),
    /requires RELAYER_MAX_GAS_PER_TX/,
  );
});

test("an enabled relayer without a key is rejected", () => {
  assert.throws(
    () => loadConfig({ ...BASE, RELAYER_ENABLED: "true" }),
    /requires RELAYER_PRIVATE_KEY/,
  );
});

test("invalid numbers and booleans fail closed", () => {
  assert.throws(() => loadConfig({ ...BASE, CLAIM_CONFIRMATIONS: "0" }), /CLAIM_CONFIRMATIONS/);
  assert.throws(() => loadConfig({ ...BASE, TRUST_PROXY: "maybe" }), /not a boolean/);
  assert.throws(() => loadConfig({ ...BASE, ALLOWED_SERIES_IDS: "1,abc" }), /invalid series id/);
});

test("the account rate limiter enforces both windows", () => {
  let now = 1_000_000;
  const limiter = createAccountRateLimiter({ perMinute: 2, perHour: 3, clock: () => now });

  limiter.consume("alice");
  limiter.consume("alice");
  assert.throws(() => limiter.consume("alice"), /Too many claim attempts/);

  now += 61_000;
  limiter.consume("alice");
  assert.throws(() => limiter.consume("alice"), /Too many claim attempts/);

  now += 3_600_000;
  limiter.consume("alice");
});
