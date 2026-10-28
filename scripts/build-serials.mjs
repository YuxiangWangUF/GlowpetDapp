#!/usr/bin/env node
/**
 * Glowpet series builder.
 *
 * Produces the Merkle root that is stored on-chain and the per-charm claim
 * credentials that go into the NFC tag / QR code:
 *
 *     signer = computeAddress(secret)              (secp256k1 private key)
 *     leaf   = keccak256(abi.encode(chainId, seriesId, serial, signer))
 *     pair   = keccak256(min(a,b) || max(a,b))        (OpenZeppelin sorted pair)
 *     odd    = the last node is promoted to the next level unchanged
 *
 * Protocol v2 commits to the credential's public signer address. The private
 * `secret` signs a recipient-bound EIP-712 Claim locally and never enters claim
 * calldata. It is a single-charm credential, not the user's wallet private key.
 *
 * Examples
 *   node scripts/build-serials.mjs --supply 100000 --label "DeltaX"
 *   node scripts/build-serials.mjs --supply 100 --split 1-100 --out .glowpet-demo
 *   node scripts/build-serials.mjs --supply 500 --proofs all --proof-format csv
 *
 * Outputs (default `deployments/series-<id>/`)
 *   series.json        public: root, supply, label, createSeries arguments
 *   deployment.txt     human-readable arguments + raw calldata
 *   private/seed.txt   SECRET: regenerates every claim secret. Never publish.
 *   proofs.csv/.json   optional bulk export (contains secrets)
 *   proofs/<n>.json    optional per-charm QR payload (contains that secret)
 */

import { AbiCoder, Interface, computeAddress, concat, keccak256 } from "ethers";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertPrivateOutput } from "./credential-safety.mjs";

const PROTOCOL_VERSION = 2;
const SERIES_STRIDE = 1_000_000n;
const MAX_LABEL_BYTES = 64; // Glowpet.MAX_LABEL_BYTES
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DEFAULT_CHAIN_ID = 11155111; // Sepolia
const coder = AbiCoder.defaultAbiCoder();

const CREATE_SERIES_ABI = new Interface([
  "function createSeries(uint256 seriesId, uint64 maxSupply, uint32 salt, bytes32 serialRoot, string label)",
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`
Glowpet series builder

Usage
  node scripts/build-serials.mjs [options]

Options
  --supply <n>          Number of charms in the series (1 .. 999,999). Default: 1000
  --series <n>          Series id stored on-chain. Default: 1
  --chain-id <n>        Chain the series will be deployed on. Default: 11155111 (Sepolia)
  --label <text>        Series label rendered under every portrait. Default: DeltaX
  --salt <n>            uint32 metadata salt (not part of the leaf). Default: 0
  --seed <0x…>          32-byte seed used to derive secrets. Default: random
  --seed-file <path>    Read the seed from a file (keeps it out of shell history)
  --out <dir>           Output directory. Default: deployments/series-<series>
  --proofs <spec>       Bulk proof export: none | all | 1-100 | 7,9,42. Default: none
  --proof-format <fmt>  json | csv | both. Default: both
  --split <spec>        Per-charm JSON files: none | all | 1-100. Default: none
  --split-dir <dir>     Directory for per-charm files. Default: <out>/proofs
  --app-url <url>       Base URL written into claimUrl. Default: http://localhost:5173
  --force               Overwrite a non-empty output directory
  --help                Show this text

Safety
  The output contains claim secrets. private/seed.txt and every proof file are
  bearer credentials: anyone who reads them can claim the matching charm.
  Never commit them and never serve them for a real series. Writing into public/
  (including through symlinks) is rejected. The --split export exists for
  demo/test series only. Protocol v2 roots are incompatible with v1 contracts.
  On Windows, private files inherit the output directory's ACLs; chmod 0600
  does not limit which Windows users can read them. Use a private directory.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      usage();
      process.exit(0);
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function intArg(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max} (got ${value})`);
  }
  return n;
}

function bytes32Arg(value) {
  const raw = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(raw)) {
    throw new Error("--seed must be a 32-byte hex value (0x followed by 64 hex chars)");
  }
  if (/^0x0{64}$/.test(raw)) throw new Error("--seed must not be zero");
  return raw;
}

function readSeedFile(file) {
  const raw = fs.readFileSync(path.resolve(String(file)), "utf8").trim();
  // Only accept the explicit `seed:` line written by this tool, or a file that
  // contains nothing but the value. This stops a public series.json root from
  // being mistaken for the master secret.
  const match =
    raw.match(/^\s*seed:\s*(0x[0-9a-fA-F]{64})\s*$/im) ??
    raw.match(/^(0x[0-9a-fA-F]{64})$/);
  if (!match) {
    throw new Error(
      `No explicit "seed: 0x…" line found in ${file}. Refusing to guess which hash is the secret.`,
    );
  }
  return bytes32Arg(match[1]);
}

function parseSpec(spec, supply, name) {
  if (spec === undefined || spec === true || spec === "none") return [];
  if (spec === "all") return Array.from({ length: supply }, (_, i) => i + 1);

  const out = new Set();
  for (const part of String(spec).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)-(\d+)$/);
    if (range) {
      // Validate before iterating: out-of-supply ranges can otherwise allocate
      // enormous sets, and unsafe integers may never advance with n++.
      const from = intArg(range[1], name, 1, supply);
      const to = intArg(range[2], name, 1, supply);
      if (from > to) throw new Error(`--${name}: bad range "${piece}"`);
      for (let n = from; n <= to; n++) out.add(n);
      continue;
    }
    if (/^\d+$/.test(piece)) {
      out.add(Number(piece));
      continue;
    }
    throw new Error(`--${name}: cannot parse "${piece}"`);
  }

  for (const n of out) {
    if (n < 1 || n > supply) throw new Error(`--${name}: serial ${n} is outside 1..${supply}`);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

function secretFor(seed, serial) {
  for (let attempt = 0; ; attempt++) {
    const secret = keccak256(
      coder.encode(
        ["string", "bytes32", "uint32", "uint32"],
        ["Glowpet credential v2", seed, serial, attempt],
      ),
    );
    const scalar = BigInt(secret);
    if (scalar > 0n && scalar < SECP256K1_ORDER) return secret;
  }
}

function leafFor(chainId, seriesId, serial, credentialSigner) {
  // Must match Glowpet.claim:
  // keccak256(abi.encode(block.chainid, seriesId, serial, credentialSigner))
  return keccak256(
    coder.encode(
      ["uint256", "uint256", "uint32", "address"],
      [chainId, seriesId, serial, credentialSigner],
    ),
  );
}

function hashPair(a, b) {
  // OpenZeppelin's MerkleProof sorts each pair before hashing.
  return a <= b ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function buildLevels(leaves) {
  const levels = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

function proofAt(levels, index) {
  const proof = [];
  let i = index;

  for (let level = 0; level < levels.length - 1; level++) {
    const sibling = i ^ 1;
    if (sibling < levels[level].length) proof.push(levels[level][sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

function verifyProof(leaf, proof, root) {
  let hash = leaf;
  for (const node of proof) hash = hashPair(hash, node);
  return hash === root;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const started = Date.now();
  const args = parseArgs(process.argv);

  const supply = intArg(args.supply ?? 1000, "supply", 1, Number(SERIES_STRIDE) - 1);
  const seriesId = intArg(args.series ?? 1, "series", 1, Number.MAX_SAFE_INTEGER);
  const chainId = intArg(args["chain-id"] ?? DEFAULT_CHAIN_ID, "chain-id", 1, Number.MAX_SAFE_INTEGER);
  const salt = intArg(args.salt ?? 0, "salt", 0, 0xffffffff);
  const label = args.label === undefined || args.label === true ? "DeltaX" : String(args.label);
  if (Buffer.byteLength(label, "utf8") > MAX_LABEL_BYTES) {
    throw new Error(`--label must be at most ${MAX_LABEL_BYTES} UTF-8 bytes (the contract limit)`);
  }
  if (args.seed && args["seed-file"]) {
    throw new Error("Use either --seed or --seed-file, not both");
  }
  const seed =
    args["seed-file"] && args["seed-file"] !== true
      ? readSeedFile(String(args["seed-file"]))
      : args.seed === undefined || args.seed === true
        ? "0x" + randomBytes(32).toString("hex")
        : bytes32Arg(args.seed);
  const outDir = path.resolve(args.out && args.out !== true ? String(args.out) : `deployments/series-${seriesId}`);
  const splitDir = path.resolve(
    args["split-dir"] && args["split-dir"] !== true ? String(args["split-dir"]) : path.join(outDir, "proofs"),
  );
  const appUrlRaw = args["app-url"] && args["app-url"] !== true ? String(args["app-url"]) : "http://localhost:5173";
  let appUrl;
  try {
    const parsed = new URL(appUrlRaw);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("scheme");
    appUrl = appUrlRaw;
  } catch {
    throw new Error("--app-url must be an http(s) URL");
  }

  const publicDirectories = [
    path.resolve("public"),
    fileURLToPath(new URL("../public", import.meta.url)),
  ];
  assertPrivateOutput(outDir, publicDirectories);
  assertPrivateOutput(splitDir, publicDirectories);
  const proofSpec = parseSpec(args.proofs, supply, "proofs");
  const splitSpec = parseSpec(args.split, supply, "split");
  const proofFormat = String(args["proof-format"] ?? "both");
  if (!["json", "csv", "both"].includes(proofFormat)) {
    throw new Error("--proof-format must be json, csv or both");
  }
  // Validate existing child symlinks too, before creating or writing any files.
  const outputFiles = [
    path.join(outDir, "series.json"),
    path.join(outDir, "deployment.txt"),
    path.join(outDir, "private", "seed.txt"),
    ...(proofSpec.length ? ["proofs.json", "proofs.csv"].map((name) => path.join(outDir, name)) : []),
    ...splitSpec.map((serial) => path.join(splitDir, `${serial}.json`)),
  ];
  for (const file of outputFiles) assertPrivateOutput(file, publicDirectories);

  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0 && !args.force) {
    throw new Error(`Output directory is not empty: ${outDir}\nUse --force to overwrite.`);
  }
  if (!args.force) {
    const existingSplit = splitSpec.map((serial) => path.join(splitDir, `${serial}.json`))
      .find((file) => fs.existsSync(file));
    if (existingSplit) {
      throw new Error(`Claim credential already exists: ${existingSplit}\nUse --force to overwrite.`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log("Glowpet series builder");
  console.log(`  series   ${seriesId} (${label})`);
  console.log(`  supply   ${supply.toLocaleString("en-US")}`);
  console.log(`  root     deriving ${supply.toLocaleString("en-US")} leaves…`);

  // Build credentials in serial order, then sort leaves exactly like the tree
  // does. The index map is what turns a serial into a proof.
  const credentials = new Array(supply);
  for (let serial = 1; serial <= supply; serial++) {
    const secret = secretFor(seed, serial);
    const credentialSigner = computeAddress(secret);
    credentials[serial - 1] = {
      serial,
      secret,
      credentialSigner,
      leaf: leafFor(chainId, seriesId, serial, credentialSigner),
    };
  }

  const sorted = credentials.slice().sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const indexBySerial = new Map(sorted.map((c, i) => [c.serial, i]));
  const levels = buildLevels(sorted.map((c) => c.leaf));
  const root = levels[levels.length - 1][0];

  if (!/^0x[0-9a-f]{64}$/.test(root)) throw new Error("Root derivation failed");

  // Verify a sample even when no proof file is written.
  const sample = [...indexBySerial.keys()].sort((a, b) => a - b).filter((_, i, all) => {
    const step = Math.max(1, Math.floor(all.length / 64));
    return i % step === 0;
  }).slice(0, 64);

  for (const serial of sample) {
    const c = credentials[serial - 1];
    const proof = proofAt(levels, indexBySerial.get(serial));
    if (!verifyProof(c.leaf, proof, root)) {
      throw new Error(`Self-check failed for serial ${serial}`);
    }
  }

  // --- public metadata -----------------------------------------------------
  const seriesInfo = {
    protocolVersion: PROTOCOL_VERSION,
    seriesId,
    label,
    maxSupply: supply,
    salt,
    saltNote: "Stored on-chain for metadata; not part of the leaf.",
    serialRoot: root,
    tokenIdBase: (BigInt(seriesId) * SERIES_STRIDE).toString(),
    leafCount: supply,
    leaf: "keccak256(abi.encode(uint256 chainId, uint256 seriesId, uint32 serial, address credentialSigner))",
    claimDomainVersion: String(PROTOCOL_VERSION),
    tree: "sorted-pair keccak256; an odd trailing node is promoted unchanged",
    chainId,
    createdAt: new Date().toISOString(),
  };
  writeJson(path.join(outDir, "series.json"), seriesInfo);

  const calldata = CREATE_SERIES_ABI.encodeFunctionData("createSeries", [seriesId, supply, salt, root, label]);
  fs.writeFileSync(
    path.join(outDir, "deployment.txt"),
    [
      "Glowpet.createSeries",
      `Claim protocol: ${PROTOCOL_VERSION} (requires claimProtocolVersion() == ${PROTOCOL_VERSION})`,
      "Protocol v1 contracts, Merkle roots and proofs are not compatible.",
      "",
      `  seriesId   : ${seriesId}`,
      `  maxSupply  : ${supply}`,
      `  salt       : ${salt}`,
      `  serialRoot : ${root}`,
      `  label      : ${JSON.stringify(label)}`,
      "",
      "Paste those five values into the deployed Glowpet contract in Remix.",
      "",
      "Raw calldata:",
      calldata,
      "",
      "Deployment order (constructors):",
      "  1. GlowpetFaceArt()",
      "  2. GlowpetArt(faceArtAddress)",
      "  3. Glowpet(artAddress)",
      "",
    ].join("\n"),
  );

  // --- secret seed ---------------------------------------------------------
  const privateDir = path.join(outDir, "private");
  fs.mkdirSync(privateDir, { recursive: true });
  const seedPath = path.join(privateDir, "seed.txt");
  fs.writeFileSync(
    seedPath,
    [
      "Glowpet credential seed",
      `protocolVersion: ${PROTOCOL_VERSION}`,
      "",
      "KEEP THIS FILE SECRET.",
      "Anyone with this seed can derive every claim secret for the series and",
      "claim any charm that has not been activated yet. Do not commit it, do not",
      "serve it, and back it up before manufacturing.",
      "",
      `seriesId: ${seriesId}`,
      `seed:     ${seed}`,
      "",
      "Regenerate the same credentials with:",
      `  node scripts/build-serials.mjs --series ${seriesId} --chain-id ${chainId} --supply ${supply} --seed-file ${seedPath} --out <dir>`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.chmodSync(seedPath, 0o600);

  // --- bulk proofs ---------------------------------------------------------
  const tokenIdFor = (serial) => (BigInt(seriesId) * SERIES_STRIDE + BigInt(serial)).toString();
  const rows = (serials) =>
    serials.map((serial) => {
      const c = credentials[serial - 1];
      return {
        protocolVersion: PROTOCOL_VERSION,
        chainId,
        seriesId,
        serial,
        credentialSigner: c.credentialSigner,
        secret: c.secret,
        proof: proofAt(levels, indexBySerial.get(serial)),
        tokenId: tokenIdFor(serial),
      };
    });

  if (proofSpec.length > 0) {
    const exported = rows(proofSpec);
    for (const row of exported) {
      if (!verifyProof(credentials[row.serial - 1].leaf, row.proof, root)) {
        throw new Error(`Exported proof failed verification for serial ${row.serial}`);
      }
    }

    if (proofFormat === "json" || proofFormat === "both") {
      writeJson(path.join(outDir, "proofs.json"), {
        protocolVersion: PROTOCOL_VERSION,
        chainId,
        seriesId,
        serialRoot: root,
        count: exported.length,
        warning: "Contains claim secrets. Treat as bearer credentials.",
        items: exported,
      }, true);
    }

    if (proofFormat === "csv" || proofFormat === "both") {
      const lines = ["protocolVersion,chainId,seriesId,serial,credentialSigner,secret,proof,tokenId"];
      for (const row of exported) {
        lines.push(`${row.protocolVersion},${row.chainId},${row.seriesId},${row.serial},${row.credentialSigner},${row.secret},${row.proof.join(" ")},${row.tokenId}`);
      }
      const csvFile = path.join(outDir, "proofs.csv");
      fs.writeFileSync(csvFile, lines.join("\n") + "\n", { mode: 0o600 });
      fs.chmodSync(csvFile, 0o600);
    }
    console.log(`  proofs   ${exported.length.toLocaleString("en-US")} exported (${proofFormat})`);
  }

  // --- per-charm files -----------------------------------------------------
  if (splitSpec.length > 0) {
    fs.mkdirSync(splitDir, { recursive: true });
    if (splitSpec.length > 5000) {
      console.warn(`  WARNING  writing ${splitSpec.length.toLocaleString("en-US")} individual files`);
    }

    for (const serial of splitSpec) {
      const c = credentials[serial - 1];
      const proof = proofAt(levels, indexBySerial.get(serial));
      if (!verifyProof(c.leaf, proof, root)) {
        throw new Error(`Split proof failed verification for serial ${serial}`);
      }

      const params = new URLSearchParams({
        protocolVersion: String(PROTOCOL_VERSION),
        chainId: String(chainId),
        series: String(seriesId),
        serial: String(serial),
        credentialSigner: c.credentialSigner,
        secret: c.secret,
        proof: proof.join(","),
      });
      // The credential stays out of the HTTP request path. A fragment is not
      // encryption, but browsers do not send it to the server, CDN or Referer.
      const claimUrl = `${appUrl.replace(/\/$/, "")}/#claim=${params.toString()}`;

      writeJson(path.join(splitDir, `${serial}.json`), {
        v: PROTOCOL_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        chainId,
        seriesId,
        serial,
        tokenId: tokenIdFor(serial),
        secret: c.secret,
        credentialSigner: c.credentialSigner,
        proof,
        claimUrl,
        warning: "Bearer credential. Anyone who scans this can claim the charm.",
      }, true);
    }
    console.log(`  split    ${splitSpec.length.toLocaleString("en-US")} files -> ${splitDir}`);
  }

  console.log(`  root     ${root}`);
  console.log(`  seed     ${seedPath} (secret)`);
  console.log(`  output   ${outDir}`);
  console.log(`  elapsed  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("");
  console.log("Next: deploy GlowpetFaceArt -> GlowpetArt -> Glowpet, then call createSeries");
  console.log(`with the arguments in ${path.join(outDir, "deployment.txt")}.`);
}

function writeJson(file, value, privateFile = false) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", privateFile ? { mode: 0o600 } : {});
  if (privateFile) fs.chmodSync(file, 0o600);
}

try {
  main();
} catch (error) {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
}
