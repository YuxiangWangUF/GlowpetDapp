import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestContext } from "./helpers/test-context.js";

const TOKEN_ID = "1000007";

function actionBody(actionId, expectedRevision, action) {
  return { actionId, expectedRevision: String(expectedRevision), action };
}

test("email identity resolves to one fixed wallet and private routes require a token", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const first = await ctx.me("alice@example.com");
  const second = await ctx.me("alice@example.com");
  const other = await ctx.me("bob@example.com");

  assert.equal(first.response.statusCode, 200);
  assert.equal(first.body.wallet.address, second.body.wallet.address);
  assert.notEqual(first.body.wallet.address, other.body.wallet.address);
  assert.equal(first.body.capabilities.sponsoredClaim, true);
  assert.equal(first.body.capabilities.cloudGarden, true);

  const anonymous = await ctx.app.inject({ method: "GET", url: "/api/v1/me" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().code, "AUTH_REQUIRED");

  const badToken = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer not-a-mock-token" },
  });
  assert.equal(badToken.statusCode, 401);

  const health = await ctx.app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
  assert.equal(JSON.stringify(health.json()).includes("PRIVY_APP_SECRET"), false);
});

test("a zero-balance user can queue, sponsor and confirm a claim exactly once", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity } = await ctx.me();
  const claim = await ctx.makeClaimBody();
  const key = randomUUID();
  const headers = ctx.authHeaders(identity, { "idempotency-key": key });

  const submitted = await ctx.app.inject({
    method: "POST", url: "/api/v1/claims", headers, payload: claim.body,
  });
  assert.equal(submitted.statusCode, 202, submitted.body);
  const queued = submitted.json();
  assert.equal(queued.status, "QUEUED");

  const repeated = await ctx.app.inject({
    method: "POST", url: "/api/v1/claims", headers, payload: claim.body,
  });
  assert.equal(repeated.statusCode, 202);
  assert.equal(repeated.json().jobId, queued.jobId);

  const count = await ctx.db.query("SELECT COUNT(*)::int AS count FROM claim_jobs");
  assert.equal(count.rows[0].count, 1);

  await ctx.worker.tick();
  let job = (await ctx.app.inject({
    method: "GET", url: `/api/v1/claims/${queued.jobId}`, headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(job.status, "PENDING");
  assert.equal(ctx.chain.broadcasts.length, 1);
  assert.ok(job.txHash);

  ctx.chain.mineSuccess();
  await ctx.worker.tick();
  job = (await ctx.app.inject({
    method: "GET", url: `/api/v1/claims/${queued.jobId}`, headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(job.status, "MINED_SUCCESS");
  assert.equal(job.confirmations, 1);
  assert.equal(job.mintedToRecipient, true);

  ctx.chain.advanceBlocks(1);
  await ctx.worker.tick();
  job = (await ctx.app.inject({
    method: "GET", url: `/api/v1/claims/${queued.jobId}`, headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(job.status, "CONFIRMED");
  assert.equal(job.tokenId, TOKEN_ID);
  assert.equal(job.confirmations, 2);
  assert.equal(
    ctx.chain.claims.get(TOKEN_ID).recipient.toLowerCase(),
    (await ctx.me()).body.wallet.address.toLowerCase(),
  );

  const slot = await ctx.db.query("SELECT * FROM nonce_slots");
  assert.equal(slot.rows.length, 1);
  assert.ok(slot.rows[0].finalized_at);
  const budget = await ctx.db.query("SELECT * FROM sponsor_budget");
  assert.equal(budget.rows.length, 1);
  assert.ok(BigInt(budget.rows[0].spent_wei) > 0n);
  assert.equal(BigInt(budget.rows[0].reserved_wei), 0n);

  const attempts = await ctx.db.query("SELECT * FROM tx_attempts");
  assert.equal(attempts.rows.length, 1);
  assert.ok(attempts.rows[0].finalized_at);
});

test("repeated and concurrent submissions create one job and one nonce slot", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity } = await ctx.me();
  const claim = await ctx.makeClaimBody();
  const key = randomUUID();
  const headers = ctx.authHeaders(identity, { "idempotency-key": key });

  const responses = await Promise.all(Array.from({ length: 100 }, () =>
    ctx.app.inject({ method: "POST", url: "/api/v1/claims", headers, payload: claim.body })));
  assert.ok(responses.every((response) => response.statusCode === 202), responses.map((r) => r.body));
  assert.equal(new Set(responses.map((response) => response.json().jobId)).size, 1);

  const jobs = await ctx.db.query("SELECT COUNT(*)::int AS count FROM claim_jobs");
  assert.equal(jobs.rows[0].count, 1);
  const keys = await ctx.db.query("SELECT COUNT(*)::int AS count FROM idempotency_keys");
  assert.equal(keys.rows[0].count, 1);

  await ctx.worker.tick();
  const slots = await ctx.db.query("SELECT COUNT(*)::int AS count FROM nonce_slots");
  assert.equal(slots.rows[0].count, 1);
});

test("invalid authorization is rejected before any gas is spent", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity, body: meBody } = await ctx.me();
  const key = () => randomUUID();
  const submit = (payload) => ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(identity, { "idempotency-key": key() }),
    payload,
  });

  const wrongRecipient = await ctx.makeClaimBody({
    recipient: "0x0000000000000000000000000000000000009999",
  });
  let response = await submit(wrongRecipient.body);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "RECIPIENT_MISMATCH");

  const expired = await ctx.makeClaimBody({
    deadline: BigInt(Math.floor(Date.now() / 1000) - 5),
  });
  response = await submit(expired.body);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "AUTHORIZATION_EXPIRED");

  const badSignature = await ctx.makeClaimBody({
    signatureOverride: `0x${"11".repeat(65)}`,
  });
  response = await submit(badSignature.body);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_SIGNATURE");

  const badProof = await ctx.makeClaimBody({
    proof: [`0x${"22".repeat(32)}`],
  });
  response = await submit(badProof.body);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_PROOF");

  assert.equal(ctx.chain.broadcasts.length, 0);
  const jobs = await ctx.db.query("SELECT COUNT(*)::int AS count FROM claim_jobs");
  assert.equal(jobs.rows[0].count, 0);
  assert.ok(meBody.wallet.address);
});

test("a second account cannot take a charm already in the queue", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const alice = await ctx.me("alice@example.com");
  const bob = await ctx.me("bob@example.com");
  const aliceClaim = await ctx.makeClaimBody({ email: "alice@example.com" });

  const first = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(alice.identity, { "idempotency-key": randomUUID() }),
    payload: aliceClaim.body,
  });
  assert.equal(first.statusCode, 202);

  const bobClaim = await ctx.makeClaimBody({ email: "bob@example.com" });
  const second = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(bob.identity, { "idempotency-key": randomUUID() }),
    payload: bobClaim.body,
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "CLAIM_CONFLICT");
});

test("an exhausted daily budget pauses new broadcasts without creating a job", async (t) => {
  const ctx = await createTestContext({
    configOverrides: { RELAYER_DAILY_BUDGET_WEI: "1000" },
  });
  t.after(() => ctx.close());

  const { identity } = await ctx.me();
  const claim = await ctx.makeClaimBody();
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: claim.body,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "BUDGET_EXHAUSTED");
  const jobs = await ctx.db.query("SELECT COUNT(*)::int AS count FROM claim_jobs");
  assert.equal(jobs.rows[0].count, 0);
  assert.equal(ctx.chain.broadcasts.length, 0);
});

test("a lost broadcast response keeps one raw transaction and retries the same hash", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity } = await ctx.me();
  const claim = await ctx.makeClaimBody();
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: claim.body,
  });
  const jobId = response.json().jobId;

  ctx.chain.failNextBroadcasts(2);
  await ctx.worker.tick();

  let attempts = await ctx.db.query("SELECT * FROM tx_attempts");
  assert.equal(attempts.rows.length, 1);
  assert.equal(attempts.rows[0].broadcast_at, null);
  const hash = attempts.rows[0].hash;
  const job = await ctx.db.query("SELECT * FROM claim_jobs WHERE id = $1", [jobId]);
  assert.equal(job.rows[0].status, "BROADCAST_UNKNOWN");

  await ctx.worker.tick();
  attempts = await ctx.db.query("SELECT * FROM tx_attempts");
  assert.equal(attempts.rows.length, 1);
  assert.equal(attempts.rows[0].hash, hash);
  assert.ok(attempts.rows[0].broadcast_at);
  assert.equal(ctx.chain.broadcasts.length, 1);
  assert.equal(ctx.chain.broadcasts[0].hash, hash);
});

test("a third-party claim to the same recipient is recorded without minting twice", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity, body: meBody } = await ctx.me();
  ctx.chain.claimExternally(TOKEN_ID, meBody.wallet.address);
  const claim = await ctx.makeClaimBody();

  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: claim.body,
  });
  assert.equal(response.statusCode, 202);
  const job = response.json();
  assert.equal(job.status, "MINED_SUCCESS");
  assert.equal(job.confirmations, 1);
  assert.equal(job.tokenId, TOKEN_ID);
  assert.equal(job.mintedToRecipient, true);
  assert.equal(ctx.chain.broadcasts.length, 0);

  ctx.chain.advanceBlocks(1);
  await ctx.worker.tick();
  const confirmed = (await ctx.app.inject({
    method: "GET",
    url: `/api/v1/claims/${job.jobId}`,
    headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(confirmed.status, "CONFIRMED");

  const bob = await ctx.me("bob@example.com");
  const second = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(bob.identity, { "idempotency-key": randomUUID() }),
    payload: (await ctx.makeClaimBody({ email: "bob@example.com" })).body,
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "CLAIM_CONFLICT");
});

test("cloud garden actions are revisioned, idempotent and only reward once", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity, body: meBody } = await ctx.me();
  ctx.chain.setOwner(TOKEN_ID, meBody.wallet.address);
  const headers = ctx.authHeaders(identity);

  let response = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  assert.equal(response.statusCode, 200);
  let garden = response.json();
  assert.equal(garden.revision, "0");
  assert.equal(garden.state.coins, 20);

  const buyId = randomUUID();
  response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(buyId, 0, { type: "buy", cropId: "carrot" }),
  });
  assert.equal(response.statusCode, 200);
  garden = response.json();
  assert.equal(garden.revision, "1");
  assert.equal(garden.state.seeds.carrot, 1);

  const duplicate = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(buyId, 0, { type: "buy", cropId: "carrot" }),
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().revision, "1");
  assert.equal(duplicate.json().state.seeds.carrot, 1);

  const conflict = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(buyId, 0, { type: "buy", cropId: "moonbloom" }),
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "ACTION_ID_CONFLICT");

  response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(randomUUID(), 1, { type: "plant", cropId: "carrot", plotIndex: 0 }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision, "2");

  const wrongRevision = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(randomUUID(), 1, { type: "plant", cropId: "carrot", plotIndex: 1 }),
  });
  assert.equal(wrongRevision.statusCode, 409);
  assert.equal(wrongRevision.json().code, "REVISION_CONFLICT");
  assert.equal(wrongRevision.json().details.revision, "2");

  ctx.advance(30_000);
  response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(randomUUID(), 2, { type: "harvest", plotIndex: 0 }),
  });
  assert.equal(response.statusCode, 200);
  garden = response.json();
  assert.equal(garden.revision, "3");
  assert.equal(garden.state.coins, 25);
  assert.equal(garden.state.food, 2);
  assert.equal(garden.state.xp, 10);

  const bob = await ctx.me("bob@example.com");
  const forbidden = await ctx.app.inject({
    method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers: ctx.authHeaders(bob.identity),
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "NOT_OWNER");

  const malformed = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: { actionId: randomUUID(), expectedRevision: "3", action: { type: "harvest", plotIndex: 0, xp: 9999 } },
  });
  assert.equal(malformed.statusCode, 400);

  const current = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  assert.equal(current.json().revision, "3");
});

test("concurrent cloud harvests award the crop only once", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity, body: meBody } = await ctx.me();
  ctx.chain.setOwner(TOKEN_ID, meBody.wallet.address);
  const headers = ctx.authHeaders(identity);

  // Buy two free carrot packets, plant both plots, then let them mature.
  for (const step of [
    { revision: 0, action: { type: "buy", cropId: "carrot" } },
    { revision: 1, action: { type: "buy", cropId: "carrot" } },
    { revision: 2, action: { type: "plant", cropId: "carrot", plotIndex: 0 } },
    { revision: 3, action: { type: "plant", cropId: "carrot", plotIndex: 1 } },
  ]) {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/gardens/${TOKEN_ID}/actions`,
      headers,
      payload: actionBody(randomUUID(), step.revision, step.action),
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  ctx.advance(30_000);

  const [left, right] = await Promise.all([
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/gardens/${TOKEN_ID}/actions`,
      headers,
      payload: actionBody(randomUUID(), 4, { type: "harvest", plotIndex: 0 }),
    }),
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/gardens/${TOKEN_ID}/actions`,
      headers,
      payload: actionBody(randomUUID(), 4, { type: "harvest", plotIndex: 1 }),
    }),
  ]);

  const statuses = [left.statusCode, right.statusCode].sort();
  assert.deepEqual(statuses, [200, 409]);

  const final = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  const garden = final.json();
  assert.equal(garden.revision, "5");
  assert.equal(garden.state.harvests, 1);
  assert.equal(garden.state.coins, 25);
});

test("a reverted claim can be re-authorized and retried with a new nonce", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity } = await ctx.me();
  const claim = await ctx.makeClaimBody();
  const key = randomUUID();
  const submitted = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: ctx.authHeaders(identity, { "idempotency-key": key }),
    payload: claim.body,
  });
  const jobId = submitted.json().jobId;

  await ctx.worker.tick();
  ctx.chain.mineRevert();
  await ctx.worker.tick();

  let job = (await ctx.app.inject({
    method: "GET", url: `/api/v1/claims/${jobId}`, headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(job.status, "MINED_REVERTED");

  // Re-authorization is only safe after the old nonce reaches its required
  // confirmations and is finalized, not merely after the revert is seen.
  const blocked = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/claims/${jobId}/authorization`,
    headers: ctx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: { deadline: "9999999999", signature: `0x${"11".repeat(65)}` },
  });
  assert.equal(blocked.statusCode, 409);
  ctx.chain.advanceBlocks(1);
  await ctx.worker.tick();

  const renewed = await ctx.makeClaimBody();
  const updated = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/claims/${jobId}/authorization`,
    headers: ctx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: { deadline: renewed.body.deadline, signature: renewed.body.signature },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().status, "QUEUED");

  await ctx.worker.tick();
  ctx.chain.mineSuccess();
  ctx.chain.advanceBlocks(1);
  await ctx.worker.tick();
  job = (await ctx.app.inject({
    method: "GET", url: `/api/v1/claims/${jobId}`, headers: ctx.authHeaders(identity),
  })).json();
  assert.equal(job.status, "CONFIRMED");
  assert.equal(ctx.chain.broadcasts.length, 2);
  assert.notEqual(ctx.chain.broadcasts[0].nonce, ctx.chain.broadcasts[1].nonce);
  assert.ok(ctx.chain.claims.has(TOKEN_ID));
});

test("a third-party claim to another recipient is a conflict and a garden read does not bump revision", async (t) => {
  const conflictCtx = await createTestContext();
  t.after(() => conflictCtx.close());
  const { identity } = await conflictCtx.me();
  conflictCtx.chain.claimExternally(TOKEN_ID, "0x0000000000000000000000000000000000009999");
  const conflict = await conflictCtx.app.inject({
    method: "POST",
    url: "/api/v1/claims",
    headers: conflictCtx.authHeaders(identity, { "idempotency-key": randomUUID() }),
    payload: (await conflictCtx.makeClaimBody()).body,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "CLAIM_CONFLICT");

  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await ctx.me();
  ctx.chain.setOwner(TOKEN_ID, owner.body.wallet.address);
  const headers = ctx.authHeaders(owner.identity);

  const first = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  const second = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  assert.equal(first.statusCode, 200);
  assert.equal(second.json().revision, first.json().revision);
  const row = await ctx.db.query("SELECT revision FROM gardens");
  assert.equal(String(row.rows[0].revision), first.json().revision);

  ctx.chain.setOwner(TOKEN_ID, "0x0000000000000000000000000000000000009999");
  const deniedRead = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  assert.equal(deniedRead.statusCode, 403);
  assert.equal(deniedRead.json().code, "NOT_OWNER");
  const deniedWrite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/gardens/${TOKEN_ID}/actions`,
    headers,
    payload: actionBody(randomUUID(), 0, { type: "buy", cropId: "carrot" }),
  });
  assert.equal(deniedWrite.statusCode, 403);
});

test("damaged cloud garden state is reported and preserved", async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { identity, body: meBody } = await ctx.me();
  ctx.chain.setOwner(TOKEN_ID, meBody.wallet.address);
  const headers = ctx.authHeaders(identity);
  await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  await ctx.db.query("UPDATE gardens SET state = '{}'::jsonb WHERE token_id = $1", [TOKEN_ID]);

  const response = await ctx.app.inject({ method: "GET", url: `/api/v1/gardens/${TOKEN_ID}`, headers });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "GARDEN_STATE_INVALID");
  const row = await ctx.db.query("SELECT state FROM gardens WHERE token_id = $1", [TOKEN_ID]);
  assert.deepEqual(row.rows[0].state, {});
});
