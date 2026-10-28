import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ContractFactory, HDNodeWallet, JsonRpcProvider, NonceManager } from "ethers";

const root = process.cwd();
const demoDir = path.join(root, ".glowpet-demo");
const seriesPath = path.join(demoDir, "series.json");
const rpcUrl = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const chainId = 11155111;
const mnemonic = "test test test test test test test test test test test junk";

function artifact(name) {
  const file = path.join(root, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run npm run contracts:compile first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

if (!fs.existsSync(seriesPath)) {
  throw new Error("Missing .glowpet-demo/series.json. Run the local serials command first.");
}
const series = JSON.parse(fs.readFileSync(seriesPath, "utf8"));
if (Number(series.chainId) !== chainId) {
  throw new Error(`The demo series was built for chain ${series.chainId}, expected ${chainId}.`);
}

// Validate the entire reviewed export before connecting a signer or deploying.
// A CID alone cannot establish that every reserved appearance has a real file.
const deltaXCID = process.env.DELTAX_ART_CID?.trim();
let verifiedArtwork = null;
let artworkManifestPath = null;
if (deltaXCID) {
  if (!/^bafy[a-z2-7]{55}$/.test(deltaXCID)) {
    throw new Error("DELTAX_ART_CID must be a CIDv1 dag-pb/SHA-256 directory CID without a protocol or path.");
  }
  artworkManifestPath = path.resolve(root,
    process.env.DELTAX_ART_MANIFEST?.trim() || "output/deltax-unique-v2/publish/collection.json",
  );
  const { verifyEdition } = await import("./deltax-edition.mjs");
  verifiedArtwork = await verifyEdition(artworkManifestPath);
  const supply = BigInt(series.maxSupply);
  if (supply <= 0n || supply > BigInt(verifiedArtwork.editionSize)) {
    throw new Error("The local series supply must fit inside the verified DeltaX edition.");
  }
  console.log(`Verified DeltaX edition: ${verifiedArtwork.verifiedImages} unique images; manifest SHA-256 ${verifiedArtwork.manifestSha256}`);
}

const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
const deployer = new NonceManager(
  HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").connect(provider),
);
const relayer = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/9");

console.log(`Deploying to ${rpcUrl} as ${await deployer.getAddress()}`);

let faceArtAddress = null;
let glowpet;
if (deltaXCID) {
  const compiled = artifact("DeltaXGlowpet");
  glowpet = await new ContractFactory(compiled.abi, compiled.bytecode, deployer).deploy(
    deltaXCID, verifiedArtwork.editionSize, verifiedArtwork.seed,
  );
} else {
  // No DeltaX CID: retain the existing SVG onboarding demo.
  const faceArtifact = artifact("GlowpetFaceArt");
  const faceArt = await new ContractFactory(faceArtifact.abi, faceArtifact.bytecode, deployer).deploy();
  await faceArt.waitForDeployment();
  faceArtAddress = await faceArt.getAddress();
  console.log(`GlowpetFaceArt ${faceArtAddress}`);
  const artArtifact = artifact("GlowpetArt");
  const art = await new ContractFactory(artArtifact.abi, artArtifact.bytecode, deployer).deploy(faceArtAddress);
  await art.waitForDeployment();
  const compiled = artifact("Glowpet");
  glowpet = await new ContractFactory(compiled.abi, compiled.bytecode, deployer).deploy(await art.getAddress());
}
await glowpet.waitForDeployment();
const glowpetAddress = await glowpet.getAddress();
const artAddress = await glowpet.art();
const artworkVersion = deltaXCID ? await glowpet.artworkVersion() : "legacy-svg";
if (deltaXCID && (
  artworkVersion !== verifiedArtwork.artworkVersion ||
  await glowpet.editionSize() !== BigInt(verifiedArtwork.editionSize) ||
  (await glowpet.artworkSeed()).toLowerCase() !== verifiedArtwork.seed
)) throw new Error("Deployed DeltaX artwork parameters differ from the verified export.");
console.log(`Glowpet        ${glowpetAddress}`);
console.log(`Artwork        ${artAddress}`);

const createTx = await glowpet.createSeries(
  series.seriesId,
  series.maxSupply,
  0,
  series.serialRoot,
  series.label,
);
await createTx.wait();
const protocol = Number(await glowpet.claimProtocolVersion());
if (protocol !== 2) throw new Error(`Unexpected claim protocol ${protocol}`);

const deployment = {
  chainId,
  glowpet: glowpetAddress,
  art: artAddress,
  faceArt: faceArtAddress,
  seriesId: series.seriesId,
  seriesRoot: series.serialRoot,
  relayer: relayer.address,
  deployedAt: new Date().toISOString(),
  localOnly: true,
  artworkVersion,
  portraitDirectoryCID: deltaXCID || null,
  artworkEditionSize: verifiedArtwork?.editionSize ?? null,
  artworkSeed: verifiedArtwork?.seed ?? null,
  artworkManifestSha256: verifiedArtwork?.manifestSha256 ?? null,
  artworkManifest: artworkManifestPath ? path.relative(root, artworkManifestPath).replaceAll("\\", "/") : null,
  verifiedPortraits: verifiedArtwork?.verifiedImages ?? null,
};
fs.writeFileSync(
  path.join(demoDir, "local-deployment.json"),
  `${JSON.stringify(deployment, null, 2)}\n`,
  { mode: 0o600 },
);

const serverEnv = `# Local demo only. Generated by scripts/deploy-local.mjs; never reuse these keys.
NODE_ENV=development
PORT=3001
HOST=127.0.0.1
LOG_LEVEL=info
AUTH_MODE=mock
DATABASE_URL=pglite:memory
RUN_WORKER_IN_API=true
CHAIN_ID=${chainId}
RPC_URL=${rpcUrl}
GLOWPET_ADDRESS=${glowpetAddress}
ALLOWED_SERIES_IDS=${series.seriesId}
DEPLOY_BLOCK=0
RELAYER_ENABLED=true
RELAYER_PRIVATE_KEY=${relayer.privateKey}
CLAIM_CONFIRMATIONS=1
CLAIM_AUTH_MAX_TTL_SECONDS=600
RELAYER_MAX_GAS_PER_TX=300000
RELAYER_MAX_FEE_PER_GAS_WEI=5000000000
RELAYER_DAILY_BUDGET_WEI=1000000000000000000
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
`;
fs.writeFileSync(path.join(root, "server", ".env"), serverEnv, { mode: 0o600 });

const frontendEnv = `# Local demo only. Loaded by Vite development mode, not by production builds.
VITE_AUTH_MODE=mock
VITE_API_BASE_URL=/api/v1
VITE_GLOWPET_ADDRESS=${glowpetAddress}
VITE_GLOWPET_SERIES_ID=${series.seriesId}
VITE_DEPLOY_BLOCK=0
VITE_SEPOLIA_RPC_URL=${rpcUrl}
VITE_PROOF_BASE_URL=/proofs
`;
fs.writeFileSync(path.join(root, ".env.development.local"), frontendEnv, { mode: 0o600 });

const proofPath = path.join(demoDir, "proofs", "1.json");
const proof = fs.existsSync(proofPath) ? JSON.parse(fs.readFileSync(proofPath, "utf8")) : null;

console.log("\nLocal demo configuration written:");
console.log("  server/.env              (server API + relayer)");
console.log("  .env.development.local   (frontend, development only)");
console.log("\nStart the API, worker and frontend:");
console.log("  npm run dev:server");
console.log("  npm run dev:worker");
console.log("  npm run dev");
console.log("\nSign in with alice@example.com, then open:");
console.log(proof?.claimUrl || "(proof file for serial 1 not found)");
