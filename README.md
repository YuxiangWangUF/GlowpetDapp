# Glowpet

Continuing on another device? Start with [the agent handoff](docs/AGENT_HANDOFF.md)
and [repository instructions](AGENTS.md). Use Node.js 24 LTS and `npm ci`.
The public release currently provides the homepage, artwork previews and a local
guest garden. Production accounts, cloud saves and NFT activation still require
their own service configuration and release verification.

A limited-edition physical charm with a screen, backed by a unique on-chain pet.
Each pendant carries a serial. That serial, plus a secret printed only on the
pendant's NFC tag / QR code, claims exactly one ERC-721 pet on Ethereum Sepolia.

Two artwork implementations share the v2 claim protocol. The original `Glowpet`
generates its SVG on-chain. `DeltaXGlowpet` assigns unique Chinese-inspired
accessory combinations within a finite edition and references complete PNGs on
IPFS; those raster pixels are not stored on-chain. The web app supports both.

The DeltaX v2 exporter supports 18,432 permitted combinations across five species, seven shared and one cat-exclusive
headwear designs, eight neckwear designs, eight palettes and eight motifs.
`npm run art:generate` creates a 100-pet local edition and preview by default;
`npm run art:verify` checks its frozen rules, source images, file hashes and
decoded pixel uniqueness. It does not upload or deploy. See
[`docs/DELTAX_NFT_ART.md`](docs/DELTAX_NFT_ART.md) for edition limits and release steps.

An optional account flow lets a new user sign in with a one-time email code,
receive an embedded EVM wallet, and have the platform sponsor the claim
transaction. Guest play, read-only previews, and the original external-wallet
claim remain available. The account and sponsored-claim API lives in `server/`;
its deployment guide is [`docs/ONBOARDING_DEPLOYMENT.md`](docs/ONBOARDING_DEPLOYMENT.md).

> This is a Sepolia testnet project. The tokens have no monetary value.

## What is in the box

| Piece | Where |
| --- | --- |
| Asset + claim logic | `contracts/Glowpet.sol` |
| Portrait renderer | `contracts/GlowpetArt.sol` |
| Unique DeltaX edition and immutable PNG references | `contracts/DeltaXGlowpet.sol` |
| DeltaX combination rules and Chinese accessory renderer | `shared/deltax-traits.js`, `shared/deltax-renderer.js` |
| PNG edition exporter and preview | `scripts/generate-deltax-edition.mjs` |
| Face parts (eyes, ears, accessories) | `contracts/GlowpetFaceArt.sol` |
| Shared structs and interfaces | `contracts/GlowpetTypes.sol` |
| Series / credential generator | `scripts/build-serials.mjs` |
| Browser app | `src/` |
| Account / sponsored-claim API | `server/` |
| Shared claim and garden rules | `shared/` |
| Local end-to-end demo config | `hardhat.local.config.cjs`, `scripts/deploy-local.mjs` |
| Product requirements | `docs/PRD.md` |
| Onboarding deployment guide | `docs/ONBOARDING_DEPLOYMENT.md` |

The renderer is split into three contracts only because of the 24,576-byte
deployed-bytecode limit. It is one design, not three products.
`contracts/TicketNFT.sol` is the original course starter and is not used by
Glowpet.

## How a claim works

```text
physical charm
  │  NFC / QR: serial + secret + Merkle proof
  │  credentialSigner = computeAddress(secret)
  │  secret signs a recipient-bound EIP-712 Claim locally (domain version "2")
  ▼
Glowpet.claim(seriesId, serial, credentialSigner, proof, recipient, deadline, signature)
  │  leaf = keccak256(abi.encode(block.chainid, seriesId, serial, credentialSigner))
  │  MerkleProof.verify(proof, seriesRoot, leaf)
  │  recover the credential signer from the Claim signature
  ▼
tokenId = seriesId * 1_000_000 + serial
  │
  ├─ ownerOf(tokenId)      → the buyer's wallet
  ├─ petState(tokenId)     → compact traits for the app / firmware
  └─ tokenURI(tokenId)     → base64 JSON with SVG (legacy) or fixed IPFS PNG (DeltaX)
```

### Email account and sponsored claim (optional)

```text
one-time email code
  ▼
Privy embedded EVM wallet (same address on every device)
  ▼
charm credential signs the same EIP-712 Claim in the browser
  │  only public fields are sent: proof, credentialSigner, recipient, deadline, signature
  ▼
POST /api/v1/claims  (Bearer access token + Idempotency-Key)
  │  server verifies token, wallet binding, root, proof, signature, series and simulated gas
  │  Postgres job row + idempotency record in one transaction
  ▼
claim worker → isolated relayer → Glowpet.claim(...) → NFT to the embedded wallet
  │  nonce slot, raw tx and fee reservation are persisted before broadcast
  ▼
GET /api/v1/claims/:jobId → QUEUED / SIGNED / PENDING / MINED_SUCCESS / CONFIRMED
  ▼
cloud garden (ownerOf checked by the server; actions computed server-side)
```

The server never receives the charm secret, the user's wallet private key or
any seed. The embedded wallet is a Privy EOA, not an ERC-4337 smart account;
only the claim call is sponsored. External-wallet users keep the direct
MetaMask flow.

The Merkle root, signer addresses and proofs are public information. Each
**secret is a secp256k1 private key for one charm**, derived from a random master
seed. Possessing it authorizes a claim for that charm. The app uses it only in
memory to sign a Claim and never sends it in calldata. It is unrelated to the
user's wallet private key, which remains inside MetaMask.

The leaf is bound to the deployment chain and series, so a credential cannot be
replayed on another chain or in a second series unless the same credential is
deliberately enrolled there. The EIP-712 domain uses name `Glowpet`, version `"2"`,
chain id and the contract address. Its `Claim` fields are `seriesId` (`uint256`),
`serial` (`uint32`), `recipient` (`address`) and `deadline` (`uint256`). A copied
transaction can only mint to the authorized recipient: changing that address
invalidates the credential signature. Public calldata does not reveal the
credential private key needed to sign a different recipient.

### Protocol v2 migration

The app requires `claimProtocolVersion() == 2`. **Old contracts, roots and proofs
are incompatible with v2.** The v1 claim exposed its secret in calldata; a
recipient's own signature did not prevent someone from re-signing a stolen
credential for another address. Do not use that flow for new claims.

Generate fresh v2 credentials in a new private directory, deploy the updated
contracts, create the series with the new root, and update
`VITE_GLOWPET_ADDRESS`. For example:

```bash
npm run serials -- --series 1 --supply 100 --split all --out deployments/series-1-v2
```

Keep old outputs separate for reference. Existing NFTs remain in their original
contract; this migration does not transfer them. Do not overwrite an existing
`.glowpet-demo/` just to make its old root work with v2.

## Quick start

Requirements: Node.js 24 LTS with npm for the complete toolchain. MetaMask and Sepolia ETH are needed only for chain interactions; the guest garden runs without a wallet.

> Use Node.js 24 LTS consistently for frontend, server and artwork work when
> moving between devices.

```bash
npm install
cp .env.example .env
```

Deploy the contracts (next section), then set the Glowpet address in `.env`:

```env
VITE_GLOWPET_ADDRESS=0xYourDeployedGlowpetAddress
VITE_GLOWPET_SERIES_ID=1
```

```bash
npm run dev
```

Open the URL Vite prints, usually `http://localhost:5173`.

### Local zero-wallet demo (no MetaMask, no Sepolia)

This path uses a local Hardhat node, synthetic credentials, the mock identity
provider, an embedded PostgreSQL (PGlite) database and an in-process worker. It
is for development only. The generated keys are the public Hardhat test keys;
never send real funds to them.

```bash
npm ci
npm run contracts:compile
npm run local:node        # terminal 1; chain id 11155111 on 127.0.0.1:8545
npm run serials -- --supply 3 --chain-id 11155111 --series 1 \
  --out .glowpet-demo --split 1-3 --split-dir .glowpet-demo/proofs
npm run local:deploy      # terminal 2; writes server/.env + .env.development.local
npm run dev:server        # terminal 3; mock auth, PGlite, inline claim worker
npm run dev               # terminal 4
```

Open `http://127.0.0.1:5173`, sign in with `alice@example.com`, then open the
`claimUrl` from `.glowpet-demo/proofs/1.json`. The claim is queued, signed and
broadcast by the local relayer, and the pet is minted to the mock account's
fixed wallet. The same account in a second tab sees the same wallet, pet and
cloud garden.

`local:deploy` writes ignored files containing a test private key:

- `server/.env` — mock auth, PGlite memory database, local RPC and relayer.
- `.env.development.local` — Vite development-only mock auth and local addresses.

PGlite memory resets when the API restarts; the demo is not a persistence test.
For a persistent local database use PostgreSQL and run `npm run db:migrate`,
`npm run dev:server`, and `npm run dev:worker` as separate processes.

## 1. Build a series

The builder creates the Merkle root and the claim credentials.

```bash
# Production-shaped series (writes deployments/series-1/)
npm run serials -- --supply 100000 --label "DeltaX" --out deployments/series-1
```

```bash
# Demo series with 100 charms and a QR-ready file for each one
npm run serials:demo
```

Useful options:

| Option | Meaning |
| --- | --- |
| `--supply <n>` | Number of charms (1–999,999) |
| `--series <n>` | Series id stored on-chain |
| `--chain-id <n>` | Chain the series will be deployed on (default Sepolia `11155111`) |
| `--label <text>` | Label rendered under each portrait |
| `--seed <0x…>` | Reuse a previous 32-byte seed (reproducible credentials) |
| `--seed-file <path>` | Read the seed from a file, keeping it out of shell history |
| `--out <dir>` | Output directory |
| `--proofs <spec>` | Bulk export: `all`, `1-100`, `7,9,42` |
| `--split <spec>` | One JSON file per charm (QR payload) |
| `--app-url <url>` | Base URL placed in each `claimUrl` |

Outputs:

```text
deployments/series-1/
├── series.json          # public: root, supply, label, createSeries args
├── deployment.txt       # the five createSeries values + raw calldata
├── proofs.csv           # optional bulk export (contains secrets)
├── proofs.json          # optional bulk export (contains secrets)
├── proofs/<n>.json      # optional per-charm QR payload (contains that secret)
└── private/seed.txt     # SECRET: regenerates every claim secret
```

> **Treat `private/seed.txt` and every proof file as bearer credentials.**
> Anyone who reads one can claim that charm. `deployments/` and
> `.glowpet-demo/` are in `.gitignore`. Never put proofs in `public/`: Vite
> copies that directory into `dist/`. The generator rejects output or split
> directories inside `public/`, including symlink targets. The production build
> rejects nested JSON credentials, CSV credential exports and seed text files
> anywhere under `public/`, including linked directories. The demo command writes
> to `.glowpet-demo/proofs/`, which only the Vite dev server serves.

Every generated credential and claim URL includes `protocolVersion=2`. The
master seed and proof exports use owner-only file permissions on POSIX.
On Windows, files inherit the output directory's ACLs; `chmod 0600` does not
restrict access to the current user. Generate credentials in a private directory.

### Regenerating without exposing the seed

Passing the master seed on the command line leaves it in shell history and in
the process list. Use `--seed-file` instead:

```bash
npm run serials -- --series 1 --supply 100000 \
  --seed-file deployments/series-1/private/seed.txt --out deployments/series-1-new
```

The builder self-checks every exported proof against the root before writing.

## 2. Deploy with Remix

1. Open [Remix](https://remix.ethereum.org/).
2. Create the four files from `contracts/`: `GlowpetTypes.sol`, `GlowpetFaceArt.sol`,
   `GlowpetArt.sol`, `Glowpet.sol`. Keep them in the same folder so the relative
   imports resolve.
3. Compiler: **0.8.30** (or a compatible 0.8.x).
   Match the local validation settings: optimizer enabled, **200 runs**,
   **`viaIR: true`**. `npm run contracts:compile` uses the pinned local compiler
   and checks the deployed bytecode size of all three contracts.
4. **EVM version: `cancun`.** OpenZeppelin 5.6.1 uses the `mcopy` opcode; a
   `shanghai` build fails. In Remix the compiler setting is under
   *Advanced configuration → EVM Version*.
5. Open **Deploy & Run Transactions**, choose **Injected Provider - MetaMask**,
   and select **Sepolia**.

Deploy in this order — the constructors take the previous address:

| Step | Contract | Constructor argument |
| --- | --- | --- |
| 1 | `GlowpetFaceArt` | none |
| 2 | `GlowpetArt` | the FaceArt address |
| 3 | `Glowpet` | the Art address |

Then create the series on **Glowpet**:

```text
createSeries(
  seriesId   = 1,
  maxSupply  = 100000,
  salt       = 0,
  serialRoot = 0x…        ← from series.json
  label      = "DeltaX"
)
```

`label` is UTF-8 and limited to 64 bytes. `deployment.txt` contains the exact
values and a raw calldata fallback.

Copy the **Glowpet** address into `.env`. Do not use the FaceArt or Art address
in the frontend.

## 3. Configure the app

```env
VITE_GLOWPET_ADDRESS=0x…        # Glowpet, not GlowpetArt
VITE_GLOWPET_SERIES_ID=1
VITE_DEPLOY_BLOCK=0             # set to the deployment block for faster event scans
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_PROOF_BASE_URL=/proofs     # demo only; empty disables "Load proof"
```

All `VITE_*` values are public because Vite bundles them into the browser.
Never put a private key, mnemonic, seed, or API secret in an env file.

Restart `npm run dev` after changing `.env`.

### Account API and sponsored claims

`VITE_AUTH_MODE` selects the browser account mode:

| Value | Behavior |
| --- | --- |
| `off` | guest/read-only plus the existing external wallet; this is the default |
| `privy` | email one-time-code login and an embedded wallet; requires `VITE_PRIVY_APP_ID` |
| `mock` | local development only; `vite build` refuses to produce a production build |

The API needs its own server-only configuration. Copy
[`server/.env.example`](server/.env.example) to `server/.env` and set:

```env
AUTH_MODE=privy
PRIVY_APP_ID=...              # same app as the browser
PRIVY_APP_SECRET=...          # server secret store only
DATABASE_URL=postgres://...
CHAIN_ID=11155111
RPC_URL=https://...
GLOWPET_ADDRESS=0x...         # Glowpet, not the art contracts
ALLOWED_SERIES_IDS=1
RELAYER_ENABLED=true
RELAYER_PRIVATE_KEY=...       # dedicated low-balance testnet account
RELAYER_MAX_GAS_PER_TX=...
RELAYER_MAX_FEE_PER_GAS_WEI=...
RELAYER_DAILY_BUDGET_WEI=...
```

`RELAYER_ENABLED=true` without all three limits fails closed. The relayer must
be a separate, non-owner Sepolia account; it must not be a user wallet or the
deployer. See [`docs/ONBOARDING_DEPLOYMENT.md`](docs/ONBOARDING_DEPLOYMENT.md)
for the full runbook, state machine, budget/nonce recovery and API contract.

Run the API and worker separately against PostgreSQL:

```bash
npm run db:migrate
npm run dev:server
npm run dev:worker
```

For the local PGlite demo, `npm run local:deploy` writes a mock-auth
`server/.env`; because PGlite is single-process, that file also sets
`RUN_WORKER_IN_API=true` and `npm run dev:server` starts the worker in-process.
Do not use that setting for PostgreSQL production deployments.

The API exposes `GET /api/v1/me`, `POST /api/v1/claims`,
`GET /api/v1/claims/:jobId`, `GET /api/v1/claims`,
`POST /api/v1/claims/:jobId/authorization`,
`GET /api/v1/gardens/:tokenId`, and
`POST /api/v1/gardens/:tokenId/actions`. Private responses are `no-store`;
the claim API accepts only public authorization fields, never a secret, seed,
private key, arbitrary calldata or RPC URL.

## 4. Activate a charm

A charm's QR code contains a link shaped like:

```text
https://your-app/#claim=protocolVersion=2&chainId=11155111&series=1&serial=7&credentialSigner=0x…&secret=0x…&proof=0x…,0x…
```

The credential is in the URL fragment, which browsers do not send to the
server, CDN or Referer. The app captures it into page memory during the first
script, immediately replaces the URL, and only then loads the sign-in SDK. Legacy
`?...` claim links still parse, but their secret is unavoidably in the first
HTTP request; production ingress must not log full URLs and should set
`Referrer-Policy: no-referrer`.

Opening the link pre-fills the form. You can also paste the link or the JSON
payload under **Have a claim link or QR payload?**, or type the serial, secret
and proof manually.

Clicking **Activate Glowpet** creates an EIP-712 signature in memory using the
charm credential and asks MetaMask to submit the claim transaction. The
signature binds the claim to the connected recipient address; a relayer cannot
change that recipient. The app does not request or read your wallet private key.
After confirmation, it reads `tokenURI` and `petState` and shows the portrait.
The transaction link points to Sepolia Etherscan.

`?token=1000001` opens any pet in read-only mode, without connecting a wallet.
That is also the URL to share a pet.

Select **Pendant mode** on a pet, or open
`?token=1000001&view=pendant`, for a 240 × 240 browser pendant preview.
It checks the chain every five seconds and updates the portrait, stage and
current owner. Failed reads keep the last portrait visible with an offline
status and retry automatically. This preview requires no wallet; physical BLE
pairing is still a later milestone.

### Demo without a pendant

```bash
npm run serials:demo
```

This builds a 100-charm series and writes `.glowpet-demo/proofs/1.json … 100.json`.
The command refuses to overwrite a non-empty demo directory. Preserve existing
credentials; for a v1 migration, use the new-directory command above instead.
Create the series on-chain with the root from `.glowpet-demo/series.json`, set
`VITE_GLOWPET_ADDRESS`, then open the `claimUrl` inside one of the proof files.
It includes the serial, secret and proof, so the form fills itself. Click
**Activate Glowpet**.

Those files are served **only by the Vite dev server** and are never copied into
`dist/`. This is intentional: a proof file contains a claim secret, so it must
not be published with a production build. Use `.glowpet-demo/proofs` exclusively
for local demos; a real deployment writes credentials into NFC tags/QR codes.

If you deploy the demo to a local Hardhat node instead of Sepolia, generate a
matching series with `--chain-id 31337`; the leaf commits to `block.chainid`.

## The garden

Open **Garden**, or `?view=garden`, to try the care game without a wallet or a
deployed contract. The guest companion is a practice character, not an NFT.
Choose **Care & garden** on a real pet for its own local care journal;
`?view=garden&token=1000001` reopens that pet's garden.

- Plant one of three crops across three plots. Sun carrots take 30 seconds and
  are always free to plant; Glowberries take 60 seconds and Moon blooms take
  120 seconds.
- Return when a crop is ready and harvest food, garden coins and bond XP.
  Elapsed growth survives page reloads and time away.
- Feed your companion with food, or play with it after the 30-second cooldown.
  Fullness and happiness change over time; care levels rise with bond XP.
- At 150, 400 and 900 XP the journal records a local growth milestone.
  This does **not** send a transaction or change the NFT's on-chain stage.

### Local practice garden vs cloud garden

- **Guest / local journal**: no wallet or API; saved in this browser under a key
  for the chain, contract, token and current owner. This is the original mode
  and is still available offline.
- **Cloud garden**: a signed-in owner of a claimed pet gets a garden keyed to
  `account + chain + contract + token`. Every read checks `ownerOf`; every action
  is sent as `{ actionId, expectedRevision, action }` and the server runs the
  shared rules against server time. The browser never submits a whole state or
  a reward value.
- Two devices using the same account see the same revisioned state. A lost
  response is retried with the same action id and cannot harvest twice. A
  revision conflict loads the newest state instead of replaying the old action.
- When the cloud is unavailable, the last state stays visible with an offline
  label and spending/reward actions are paused. The guest garden remains usable.
- Local guest saves are **not** imported into the cloud garden. Only a valid
  format is not proof of truthful past rewards.

Guest progress and each chain/contract/token/owner combination are kept
separately. Clearing browser data or changing devices does not recover a guest
journal; blocked/full storage shows a temporary session warning. Garden coins
are game-only points and cannot be redeemed or transferred. Server-verified
on-chain milestones and anti-cheat are later work.
Where supported, browser locks serialize actions across tabs. In browsers that
disable this feature, use one garden tab at a time to avoid conflicting saves.

### DeltaX character preview and idle animation

The guest garden now uses the approved Soft & Sweet bunny, kitty, fox, mouse and
lamb. Switch between the five looks below the portrait; this changes only the
preview and keeps the same practice garden. The selected look is remembered on
this device. The homepage also shows the bunny when there is no minted pet to feature.

Transparent PNG assets live in `public/pets/deltax-soft-v1/`. The reusable
`PlushCompanion` component adds a 4.8-second breathing loop, a 3.4-second gentle
sway, subtle star twinkles and brief feed/play reactions. A lightweight mesh
deforms only the eyes and ears of the original texture: short, unevenly spaced
blinks include an occasional softer double blink, while each ear makes small,
staggered movements. Folded rabbit ears and floppy lamb ears use their own pivots
and smaller angles. The source PNGs are unchanged.

Facial animation pauses when the page is hidden and falls back to the original
portrait if graphics acceleration is unavailable. Garden companions automatically
play their idle animation on entry, refresh and selection, including when the
device requests reduced motion. There is no playback button or saved pause state.
The original on-chain artwork,
NFT species and credentials are unchanged. This visual update is not a deployment.

For local visual checks, `output/glowpet-concepts/idle-study.html` can be opened
through the development server. It shows all five characters with controls for
open eyes, closed eyes, ear movement and the full idle loop.

### Prepared v2 series (not deployed)

On 2026-10-20 a fresh Sepolia series with 100 credentials was generated under
`deployments/series-1-v2-20261020/`. All 100 individual proofs were independently
verified. Its public parameters and undeployed status are recorded in
[`docs/v2-series.json`](docs/v2-series.json). The seed and per-charm credentials
remain in the ignored private output directory. The existing local deployment
and older credentials were preserved; these new credentials are not usable
against the old root.

## The art

On 2026-10-20 the user approved the soft A direction for **DeltaX**: rabbit,
cat, fox, mouse and sheep. The approved visual references and model catalog
are recorded in [`docs/deltax-base-models.json`](docs/deltax-base-models.json);
the proposed token-derived variation plan is in PRD §9.3.1. These are concept
art references, not yet composable runtime assets. The current renderer below
still uses the original 14-species design; no deployed NFT artwork was changed.

- 14 species: cat, dog, rabbit, bear, fox, panda, frog, sheep, pig, mouse,
  penguin, cow, tiger, lion.
- Head-only portrait, no body and no hair, with radial shading, a specular
  highlight, ambient occlusion and a contact shadow.
- Six eye styles, six eyewear styles, six accessories, three mouth styles.
- Traits come from `keccak256(abi.encode(tokenId))`; the same token always
  produces the same pet.
- The SVG contains stable group ids (`gp-root`, `gp-head`, `gp-ears`,
  `gp-mane`, `gp-eyes`, `gp-face`, `gp-eyewear`, `gp-accessory-front`) so the
  app can animate the same artwork instead of drawing a second version.
- Web idle loop: the head (with ears and mane) bobs and breathes, the eyes
  blink, and the accessory sways. It respects `prefers-reduced-motion`; append
  `?motion=1` to preview the loop when Reduce Motion is enabled. The pendant
  firmware does not run this loop yet.

Stage 0 has no ring. Any evolved stage adds the gold ring. Evolution is an
owner-operated call in this MVP (`evolve(tokenId, stage)`); a production release
moves it behind a signed milestone or a game server.

## Security notes

- The claim secret is a bearer credential. It is never emitted in the `Claimed`
  event and never stored in contract storage; only the leaf is committed via the
  root.
- The frontend never asks for a wallet private key and does not custody funds.
  It handles the scanned single-charm private key in memory for the claim
  signature, and uses MetaMask to submit the transaction.
- The claim secret is stripped from the address bar as soon as the first script
  captures it, before the sign-in SDK loads. New links use a URL fragment; do
  not log claim URLs, and keep third-party scripts off the page.
- The account API verifies the identity provider's access token signature,
  issuer and audience. It does not trust a client-supplied email or address.
- An account is bound to one embedded wallet per chain. A later provider wallet
  with a different address is rejected (`WALLET_CHANGED`) instead of silently
  replacing the binding. Claim recipients must equal that verified wallet.
- The relayer is a separate low-balance, non-owner account. Every broadcast
  requires an explicit gas cap, fee cap and daily budget; the worker persists
  the nonce slot and raw signed transaction before sending. `raw_signed_tx` is
  never an API field or a normal log line.
- Cloud garden reads and writes re-check on-chain ownership. Writes use a
  fresh ownership snapshot, a locked row, an expected revision and an action
  id. A lost response is retried with the same action id, not a new reward.
- `AUTH_MODE=mock` and `VITE_AUTH_MODE=mock` are development-only. Production
  startup rejects mock auth, and `vite build` rejects a mock browser mode.
- PGlite (`DATABASE_URL=pglite:...`) is a local convenience. Use PostgreSQL for
  the API and worker, and do not run two PGlite processes against one data
  directory.
- Server logs use `requestId`, `jobId`, status, error code, public transaction
  hash and fee fields; they do not include request bodies, claim secrets,
  signatures as content or the relayer private key.
- `tokenURI` art is generated by our contract; before inlining it, the app runs
  it through DOMPurify's SVG profile. The renderer also XML-escapes the series
  label so a label cannot inject SVG.
- `public/_headers` is a CSP / no-referrer / frame-denial template for
  Netlify and Cloudflare Pages. If you change `VITE_SEPOLIA_RPC_URL`, add its
  origin to `connect-src` in that file.
- The series label is owner-supplied. Treat `createSeries` and `evolve` as
  privileged operations: the owner can evolve any pet and close a series.
- The app does not promise investment returns and does not price the token.
- This is a testnet deployment. Do not send mainnet ETH to any address shown
  here.

### Known risks that need a design decision

1. **Claim transaction visibility.** A v2 transaction exposes the credential's
   public address, proof, recipient and signature. The credential private key
   stays off-chain. Copying the signed request can submit the same recipient's
   claim, but cannot authorize a different recipient. Anyone who obtains the
   original QR/NFC secret before the claim can still sign their own request.
2. **Physical credential exposure.** Anyone who photographs the QR/NFC tag
   before the sale can claim the charm. Use tamper-evident or scratch-off
   packaging and activate at the point of sale.
3. **Master seed exposure.** One seed derives every claim secret in the series.
   Keep `private/seed.txt` off shared drives, use `--seed-file` rather than
   `--seed`, and consider per-batch seeds or an HSM for production.
4. **Cross-series replay (fixed).** The leaf commits to `block.chainid`,
   `seriesId`, `serial` and `credentialSigner`; an existing proof fails for
   another series or chain. The signature additionally binds the contract
   address. The builder must be given the
   deployment chain (`--chain-id`) so its root matches the contract.
5. **Owner centralization.** The owner can create series, close claims, and
   evolve any token. The claim root is immutable once created, and there is no
   withdrawal or arbitrary-mint function.
6. **Immutable renderer.** `Glowpet.art` and `GlowpetArt.faceArt` have no
   setters. Both constructors reject addresses without deployed code; verify the deployment
   arguments, because a wrong renderer cannot be replaced.
7. **Relayer operations.** A compromised or underfunded relayer can pause claims
   or spend its budget. Use a dedicated address, keep only a small testnet
   balance, alert on balance and spend, and keep the pause switch independent of
   in-flight transaction tracking.
8. **Account recovery.** The embedded wallet is protected by the login method.
   Losing the only email/passkey can lock the account. Exporting a key is a
   sensitive provider flow, not an app server operation; test recovery on real
   Privy before production.
9. **Chain/database ownership race.** The API re-checks `ownerOf` and records the
   ownership block, but chain and Postgres do not share a transaction. A transfer
   immediately before a write can be missed for one block; P0 has no on-chain
   reward settlement, so do not treat cloud state as a financial entitlement.
10. **Single-instance limits and fee replacement.** The per-account rate limiter
    is in memory, and the worker reuses the same raw transaction after an
    uncertain broadcast but does not implement same-nonce fee bumping. Move the
    limiter to shared storage and add a tested replacement flow before scaling.

## Not built yet

The repository now includes the browser app, the credential pipeline, a Privy
embedded-EOA account flow, claim-only sponsored transactions and a revisioned
cloud garden. These are deliberately left for later milestones (see
`docs/PRD.md`):

- production Privy configuration, real OTP/recovery testing and a validated
  Sepolia end-to-end run; the local verification used mock identity, a local
  Hardhat chain and synthetic credentials;
- ERC-4337 smart accounts and a general Paymaster. P0 sponsors only
  `Glowpet.claim`; ordinary transfers and other calls are not sponsored;
- same-nonce fee replacement/bumping and a multi-instance shared rate limiter;
- BLE sync to the physical pendant's screen;
- server-verified on-chain care milestones/anti-cheat and additional games
  such as mahjong (the cloud garden itself is server-authoritative);
- linking an external wallet to a cloud account with a signed challenge;
- secondary-market royalties and transfer UI;
- a production proof delivery service (the factory writes NFC tags, not public
  files).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run dev:server` | Account/claim/garden API |
| `npm run dev:worker` | Sponsored-claim worker (separate process; PostgreSQL) |
| `npm run db:migrate` | Apply versioned SQL migrations |
| `npm run local:node` | Local Hardhat node with Sepolia chain id for the demo |
| `npm run local:deploy` | Deploy to that node and write ignored local env files |
| `npm run serials -- …` | Build a series, root and credentials |
| `npm run serials:demo` | 100-charm demo; dev-only proof files in `.glowpet-demo/` |
| `npm test` | Unit, browser-helper, first-party contract and server tests |
| `npm run contracts:compile` | Compile with local solc 0.8.30 and check contract bytecode limits |
| `npm run art:generate` | Export a new DeltaX edition; existing output folders are never overwritten |
| `npm run art:verify` | Verify the default edition, source provenance, PNGs and visible pixel uniqueness |
| `npm run test:unit` | Credential, URL/bootstrap, garden and browser authorization tests |
| `npm run test:contracts` | Compile, then run Hardhat tests on a disposable in-memory chain |
| `npm run test:server` | API/queue/nonce/budget/cloud-garden integration tests with PGlite |
| `node --test tests/credentials.test.mjs` | Credential v2 and public-output regression tests using temporary fixtures |

The contract tests use OpenZeppelin 5.6.1, Hardhat 2.29.1 and local solc 0.8.30
from `package-lock.json`; they do not download a compiler or touch a running
local node. Use Node 24 LTS for the complete toolchain. Run `npm ci` after
checking out these changes to install the locked dependencies.

## Contract interface

```solidity
function createSeries(uint256 seriesId, uint64 maxSupply, uint32 salt, bytes32 serialRoot, string label);
function claim(
    uint256 seriesId, uint32 serial, address credentialSigner, bytes32[] calldata proof,
    address recipient, uint256 deadline, bytes calldata signature
) returns (uint256 tokenId);
function claimProtocolVersion() pure returns (uint256); // 2
function evolve(uint256 tokenId, uint8 newStage);          // onlyOwner in this MVP
function petState(uint256 tokenId) view returns (PetState);
function tokenURI(uint256 tokenId) view returns (string);
function seriesInfo(uint256 seriesId) view returns (uint64, uint64, bool, uint32, bytes32, string);
function serialClaimed(uint256 tokenId) view returns (bool); // tokenId, not serial
```

`tokenId = seriesId * 1_000_000 + serial`.
