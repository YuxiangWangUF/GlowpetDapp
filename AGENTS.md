# Glowpet repository instructions

Read `docs/AGENT_HANDOFF.md` first when resuming this project on another device. It records the current product scope, setup commands, deployment status, and work that still needs real production configuration. Read the relevant feature document before changing that feature.

## Product and artwork

- Preserve the five soft characters: rabbit, cat, fox, mouse, and sheep. The original `deltax-soft-v1` images are guest placeholders, not proof of an NFT deployment.
- Current unique artwork is `deltax-unique-v2`: 18,432 allowed combinations in a sparse 20,480-ID space. The approved plush lion cap is exclusive to cats; the other four species have seven headwear choices.
- Frozen edition files and their manifest are provenance records. Do not overwrite them to make a verification error disappear. Generate a new edition/version for intentional artwork changes.
- Keep frontend trait generation, rendering, contract allocation, and metadata interpretation consistent.

## Credentials and runtime state

- This is a public repository. Never commit real `.env` files, wallet keys, claim secrets/proofs, API tokens, database files, browser storage exports, or runtime logs.
- `VITE_*` values are public browser configuration. Server credentials belong only in server-side configuration.
- Use the checked-in example configuration files and document required secret names without their values. Regenerate disposable local-chain fixtures on the new device.

## Verification and publishing

- Use the lockfile with `npm ci`. The handoff lists frontend, contract, server, and artwork checks; run the checks relevant to changes.
- A passing local demo does not establish production email login, cloud storage, NFT activation, IPFS publication, or cross-device recovery.
- GitHub updates and website deployments are distinct. The current handoff request authorizes saving work to GitHub; resume hosting, DNS, ICP filing, purchases, or contract deployment only when that work is requested.
- Preserve existing user changes. Do not reset the checkout or rewrite Git history to simplify a handoff.
