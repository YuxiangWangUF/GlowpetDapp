# Glowpet onboarding, sponsored claims and cloud garden

Status: **implemented and verified locally** against a real Hardhat JSON-RPC
node with mock identity, an embedded PostgreSQL (PGlite) test database, and
synthetic charm credentials. **Not verified** against a real Privy app, real
email OTPs, a real Sepolia deployment, or a second physical device. A mock
success is never a substitute for those acceptance steps.

This document is the deployment and operations companion to
[`AGENT_EXECUTION_PLAYBOOK.md`](AGENT_EXECUTION_PLAYBOOK.md) and the main
[`README`](../README.md).

## 1. What was added

| Area | Implementation |
| --- | --- |
| Account adapter | `src/auth/` — Privy email login, fixed embedded wallet, mock provider, account panel |
| Credential bootstrap | `src/claim-bootstrap.js` — fragment capture, URL scrub before the SDK loads |
| Claim client | `src/sponsored-claim.js`, `src/api/client.js` — authorization, idempotent submit, status polling |
| API | `server/app.js`, `server/routes/` — `/me`, claims, authorization update, cloud gardens |
| Identity verification | `server/auth/verifier.js` — Privy access-token verification; mock only outside production |
| Database | `server/db/migrations/` — accounts, wallet bindings, claim jobs, idempotency, nonce slots, attempts, budget, gardens |
| Claim worker | `server/services/claim-worker.js` — revalidation, nonce/budget reservation, broadcast recovery, receipt reconciliation |
| Shared rules | `shared/claim-protocol.js`, `shared/garden-state.js`, `shared/glowpet-abi.js` |
| Cloud garden | `server/services/gardens.js`, `src/useCloudGardenGame.js` |
| Local demo | `hardhat.local.config.cjs`, `scripts/deploy-local.mjs`, ignored env files |

The account and relayer flow reuses the existing v2 claim protocol. A standard v2 `claim` already accepts any
submitter and mints to an arbitrary `recipient`, so a server relayer can submit
a recipient-bound credential signature.

## 2. Trust boundaries

- The charm secret is a bearer credential. It stays in the browser tab's memory
  while the claim is submitted, signs one EIP-712 authorization, and is never
  sent to the API, database or server logs.
- The identity provider is authoritative for the user ID and embedded wallet.
  The API verifies the access token (signature, issuer, audience, subject) and
  reads the wallet from the provider's user object. It does not trust an email
  or address from the request body.
- One account is bound to one embedded-wallet address per chain. A different
  provider address is rejected rather than silently rebound.
- The relayer is a separate low-balance, non-owner account. It can submit only
  the `claim` calls selected by the server; it cannot mint arbitrarily or change
  the series.
- The cloud garden is server-authoritative. The browser sends an action and an
  expected revision, never a full state, reward, clock or XP value.
- Ownership checks use `ownerOf` on every read and write. A transfer revokes the
  old account's future writes. There is no atomicity between the chain and
  Postgres, so the API records the ownership block and does not treat cloud XP as
  a financial right.

## 3. Configuration

### Browser (public)

```env
VITE_AUTH_MODE=privy          # off | privy | mock (development only)
VITE_PRIVY_APP_ID=public_app_id
VITE_API_BASE_URL=/api/v1
VITE_GLOWPET_ADDRESS=verified_sepolia_contract
VITE_GLOWPET_SERIES_ID=1
VITE_SEPOLIA_RPC_URL=public_read_rpc
```

`vite build` refuses `VITE_AUTH_MODE=mock`. All `VITE_*` values are public.

### Server (secret)

Copy [`server/.env.example`](../server/.env.example) to `server/.env` and keep it
outside git.

```env
NODE_ENV=production
PORT=3001
AUTH_MODE=privy
PRIVY_APP_ID=matches_browser_app
PRIVY_APP_SECRET=server_secret_store
DATABASE_URL=postgres://...
CHAIN_ID=11155111
RPC_URL=https://...
GLOWPET_ADDRESS=0x...         # Glowpet, not FaceArt/Art
ALLOWED_SERIES_IDS=1
DEPLOY_BLOCK=...
RELAYER_ENABLED=true
RELAYER_PRIVATE_KEY=...       # dedicated testnet key
CLAIM_CONFIRMATIONS=2
CLAIM_AUTH_MAX_TTL_SECONDS=600
RELAYER_MAX_GAS_PER_TX=...
RELAYER_MAX_FEE_PER_GAS_WEI=...
RELAYER_DAILY_BUDGET_WEI=...
ALLOWED_ORIGINS=https://your-app.example
TRUST_PROXY=true              # only when a trusted reverse proxy sets X-Forwarded-For
```

All three relayer limits are mandatory before any broadcast. The server fails
startup if `RELAYER_ENABLED=true` without them. `NODE_ENV=production` rejects
`AUTH_MODE=mock` and requires Privy credentials.

`DATABASE_URL=pglite:...` is supported for local development only. PGlite is
single-process; run the worker in the API process with `RUN_WORKER_IN_API=true`
for that mode. Use PostgreSQL and a separate worker for any shared deployment.

### Privy dashboard checklist

- Enable email login for the app and configure the production origins.
- Set the allowed origins to the exact browser origins, including previews if
  they must sign in.
- Configure embedded Ethereum wallet creation on login
  (`users-without-wallets` in the browser provider).
- Copy the app ID to both env files and the app secret to the server secret
  store.
- Optionally configure a JWT verification key to avoid JWKS fetches.
- Test the official export/recovery UI with a non-production account. The app
  server never receives the exported private key.
- Add a passkey as a backup login method during acceptance; losing the only
  login method can lock the account.

## 4. Deployment steps

1. **Verify the contract and series.** Confirm `claimProtocolVersion() == 2`,
   the contract has code, `seriesInfo(seriesId)` is open, and the root/supply
   match the generated series. Do not copy `docs/v2-series.json` as if it were
   deployed; its `contractAddress` is null.
2. **Prepare PostgreSQL.** Create a dedicated database and role. Set
   `DATABASE_URL`. Run `npm run db:migrate`; the migration runner records each
   version in `schema_migrations`. Back up before applying future migrations.
3. **Prepare the relayer.** Create a fresh account, fund it with a small amount
   of Sepolia ETH, and set the private key only in the server secret store.
   Measure an actual claim estimate and set the gas/fee/budget caps from it.
   Keep `RELAYER_ENABLED=false` until the API and worker pass read-only checks.
4. **Start the API.** `npm run dev:server` for development or run
   `node server/index.js` under the process manager. Terminate TLS at the proxy;
   set `TRUST_PROXY` only if that proxy is trusted. Keep `/health` on the private
   network if your topology allows it.
5. **Start the worker.** `npm run dev:worker` or `node server/worker-entry.js`
   in a separate process with the same database/RPC/relayer config. Do not run
   two workers against different databases.
6. **Build and serve the frontend.** Set `VITE_AUTH_MODE=privy` and the public
   app ID/API path, then `npm run build`. Update `public/_headers` so
   `connect-src` includes the API origin, RPC origin and Privy domains.
7. **Acceptance on Sepolia.** Use two independent browser sessions/devices.
   Sign in with the same email, confirm the same wallet address, claim one
   synthetic charm, wait for `CONFIRMED`, then open the cloud garden. Check the
   Redis-free queue, nonce slot and budget rows. Then test an invalid proof, a
   second account on the same serial, and a paused relayer.

## 5. API summary

All private routes require `Authorization: Bearer <access token>` and return
`Cache-Control: no-store`.

| Route | Purpose |
| --- | --- |
| `GET /api/v1/me` | account, fixed wallet, chain/contract/series, capabilities |
| `POST /api/v1/claims` | queue a claim; requires `Idempotency-Key` |
| `GET /api/v1/claims/:jobId` | status, confirmations, token, owner, error code |
| `GET /api/v1/claims?status=active` | recover pending jobs after reload |
| `POST /api/v1/claims/:jobId/authorization` | replace an expired/reverted authorization |
| `GET /api/v1/gardens/:tokenId` | authoritative state and revision |
| `POST /api/v1/gardens/:tokenId/actions` | one revisioned garden action |

Claim requests contain only `seriesId`, `serial`, `credentialSigner`, `proof`,
`recipient`, `deadline` and `signature`. Unknown fields are rejected. The server
takes the chain, contract and allowed series from its own config; it never takes
a `to`, RPC URL, calldata or secret from the browser.

## 6. Claim state machine

```text
QUEUED -> SIGNED -> PENDING -> MINED_SUCCESS -> CONFIRMED
   |         |          |
   |         |          +-> BROADCAST_UNKNOWN -> (same raw tx retry) PENDING
   |         +-> MINED_REVERTED (after required confirmations)
   +-> EXPIRED_UNSENT
                         CLAIM_CONFLICT
                         NEEDS_RECONCILIATION
```

Hard rules implemented by the worker:

1. Lock the job and relayer-state row, re-read the job status/version and open
   nonce slot, then reserve the nonce and worst-case fee.
2. Persist the raw signed transaction, hash and reservation before broadcasting.
3. On an uncertain broadcast, rebroadcast the **same** raw transaction and hash.
   Never allocate a second nonce for the same job while a slot is open.
4. A receipt is not final until the configured confirmations are reached and
   `receipt.blockHash` is still the canonical block.
5. `MINED_REVERTED` and `BROADCAST_UNKNOWN` do not mean "failed"; they must be
   reconciled. A confirmed third-party `Claimed` event for the same recipient
   ends the business claim without minting again.
6. A different recipient is `CLAIM_CONFLICT` only after confirmations.
7. A reverted/non-broadcast authorization can be replaced only after all old
   nonce slots are finalized and no claim succeeded. The update is re-verified
   and committed in the same transaction as the new idempotency record.
8. A job's business status never releases a nonce slot. Slots stay open until
   the transaction or its confirmed result is terminal.

There is no fee-bumping/replacement transaction path yet. If a transaction is
stuck under the current fee cap, pause new broadcasts and reconcile manually
rather than releasing its nonce.

## 7. Budget and operational controls

- `sponsor_budget` is a single row per chain with `spent_wei` and `reserved_wei`.
  A new UTC day resets `spent_wei` but keeps pending reservations.
- Reserve `gasLimit × maxFeePerGas` atomically under the budget row lock before
  signing. Settlement releases reservations and charges the canonical receipt's
  `gasUsed × effectiveGasPrice`, including reverted transactions.
- If the budget or relayer balance is insufficient, new jobs stay queued with a
  `blocked_reason`; `RELAYER_ENABLED=false` returns `SPONSOR_PAUSED` for new
  submissions.
- Alert on low relayer balance, a rising `BROADCAST_UNKNOWN`/`NEEDS_RECONCILIATION`
  count, and any nonce slot older than the expected confirmation window.
- Rollback: stop new broadcasts, keep the worker reconciling existing hashes,
  then roll back application code. Do **not** truncate job/nonce tables to
  "reset" the queue; that can hide sent transactions and reuse nonces.
- Database migrations should be backward compatible additions first. Back up
  before applying and verify the worker against the new schema before allowing
  new broadcasts.

## 8. Cloud garden rules

- Key: `account_id + chain_id + contract_address + token_id`.
- Every read and write checks the current on-chain owner. A stale owner gets
  `NOT_OWNER`; a chain failure returns `CHAIN_UNAVAILABLE` and the client shows
  cached state without applying spending/reward actions.
- `GET` advances the display state with server time but does not write the row
  or increment the concurrency revision on every countdown tick.
- `POST` accepts only `buy`, `plant`, `harvest`, `feed`, `play`, with a UUID
  `actionId` and an `expectedRevision`. A duplicate action id with the same
  payload returns the stored response; a different payload returns
  `ACTION_ID_CONFLICT`. A stale revision returns `REVISION_CONFLICT` plus the
  newest state; it does not replay the action.
- The server uses the shared reducer and server time. The client cannot submit
  coins, XP, `readyAt`, `now` or a full state.
- Guest/local journals are separate and are not imported as trusted cloud
  history. Local storage is display/cache only, plus a non-sensitive outbox for
  retrying an action id.
- Cloud milestones do **not** call `evolve`; on-chain stage remains unchanged.

## 9. Historical local verification

The onboarding-specific results below were recorded before the 2026-10-28
handoff. That handoff separately passed 89 frontend/shared unit tests, 22 contract
tests and 19 server tests, plus the visitor build and 100-image artwork checks.
See [the current handoff](AGENT_HANDOFF.md) for the latest scope. The historical
browser walkthrough below was not repeated during the GitHub handoff.

Environment: Windows, Node 24.21.0, local Hardhat node (`chainId 11155111`),
PGlite in-memory, Vite dev server, mock identity.

- `npm run build`: passes.
- 50 browser/unit tests: pass.
- 17 first-party contract tests: pass.
- 19 server tests (13 API/database integration + 6 configuration/limiter):
  pass, including 100 concurrent same-key requests
  producing one job/slot, idempotent replay, recipient mismatch, invalid
  signature/proof, expired authorization, budget exhaustion, lost broadcast
  retry with the same hash, third-party claim handling, revert/re-authorization,
  revision conflicts, concurrent harvest, ownership transfer, and preserved
  damaged garden state.
- Browser: signed in with `alice@example.com`, opened a synthetic fragment link,
  the URL was scrubbed before the claim, the platform minted token 1000001 to the
  fixed embedded wallet without MetaMask or gas, the pet detail rendered, the
  cloud garden showed `Synced to your account`, and a second tab showed the same
  wallet and garden state.

Not verified here: real Privy email delivery, passkey/recovery/export, real
Sepolia RPC/contract, two physical devices, BLE display, fee replacement,
multi-instance rate limiting, and production reverse-proxy logging. These must
be completed and recorded separately before claiming production readiness.

## 10. Known limitations

- Privy is the only real identity provider implemented; there is no custom OTP
  service or self-hosted account recovery.
- The account API supports one embedded EOA per account/chain. It does not link
  an external wallet to a cloud account; external-wallet claims remain direct
  and local.
- `evolve` is still `onlyOwner`; cloud milestones do not settle on-chain.
- The per-account rate limiter is in process memory. A multi-instance deployment
  needs a shared limiter (database, gateway or Redis).
- Only `claim` is sponsored. Transfers and other calls are not.
- PGlite is for local development only. It is not a multi-process database.
- The local demo uses the public Hardhat mnemonic and mock auth. Never reuse
  those keys or enable mock auth in a public deployment.
