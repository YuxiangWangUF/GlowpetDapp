import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ContractFactory, Interface, ZeroAddress, getAddress, getCreateAddress, keccak256, toQuantity } from 'ethers';
import { verifyEdition } from './deltax-edition.mjs';
import { compileContracts } from './compile-contracts.mjs';
import { containsCredentialFields } from './credential-safety.mjs';

export const SEPOLIA_CHAIN_ID = 11155111;
export const RELEASE_EDITION_SIZE = 10_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const parseJson = (bytes, label) => {
  try { return JSON.parse(bytes); }
  catch { throw new Error(`${label} must be valid JSON.`); }
};
const publicAddress = value => {
  try { return getAddress(value); }
  catch { throw new Error('The deployer must be a valid public Ethereum address.'); }
};
const seriesInterface = new Interface([
  'function createSeries(uint256 seriesId,uint64 maxSupply,uint32 salt,bytes32 serialRoot,string label)',
]);

export function validatePublicSeries(series) {
  if (containsCredentialFields(series)) throw new Error('Use public series.json, never a seed or claim-proof export.');
  if (series?.chainId !== SEPOLIA_CHAIN_ID || series.protocolVersion !== 2 || series.claimDomainVersion !== '2') {
    throw new Error('Series must use Sepolia chain 11155111 and claim protocol v2.');
  }
  if ((series.intendedContract !== undefined && series.intendedContract !== 'DeltaXGlowpet') ||
      (series.artworkVersion !== undefined && series.artworkVersion !== 'deltax-unique-v2')) {
    throw new Error('Series artwork must target DeltaXGlowpet and deltax-unique-v2.');
  }
  if (series.maxSupply !== RELEASE_EDITION_SIZE || series.leafCount !== RELEASE_EDITION_SIZE) {
    throw new Error('This release requires exactly 10000 reserved claim slots and leaves.');
  }
  if (!Number.isSafeInteger(series.seriesId) || series.seriesId < 1 ||
      !Number.isSafeInteger(series.salt) || series.salt < 0 || series.salt > 0xffffffff) {
    throw new Error('Invalid series ID or salt.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(series.serialRoot ?? '') || /^0x0{64}$/.test(series.serialRoot)) {
    throw new Error('A nonzero bytes32 Merkle root is required.');
  }
  if (typeof series.label !== 'string' || Buffer.byteLength(series.label, 'utf8') > 64) {
    throw new Error('Series label exceeds the contract limit of 64 UTF-8 bytes.');
  }
  // Only copy known public fields. Never serialize arbitrary input fields.
  return {
    protocolVersion: 2, chainId: SEPOLIA_CHAIN_ID,
    seriesId: series.seriesId, maxSupply: series.maxSupply, salt: series.salt,
    serialRoot: series.serialRoot.toLowerCase(), label: series.label,
  };
}

/** Canonical inventory binding for independently downloaded IPFS files. */
export function publishedFileSetHash(manifest, manifestSha256) {
  if (!isHash(manifestSha256) || !Array.isArray(manifest.assets) || manifest.assets.length !== RELEASE_EDITION_SIZE) {
    throw new Error('A complete 10000-image manifest is required.');
  }
  const rows = [['collection.json', manifestSha256], ...manifest.assets.map(asset => {
    if (!/^portraits\/(?:0|[1-9][0-9]*)\.png$/.test(asset.file) || !isHash(asset.sha256)) {
      throw new Error('Invalid published file inventory.');
    }
    return [asset.file, asset.sha256];
  })];
  if (new Set(rows.map(([file]) => file)).size !== rows.length) throw new Error('Duplicate published filename.');
  rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return digest(rows.map(([file, sha256]) => `${file}\0${sha256}\n`).join(''));
}

export function validateIpfsEvidence(report, { cid, manifestSha256, fileSetSha256 }) {
  if (!/^bafy[a-z2-7]{55}$/.test(cid ?? '')) throw new Error('A real CIDv1 directory CID is required, without a URL or path.');
  if (report?.schema !== 'glowpet-ipfs-verification-v1' || report.cid !== cid ||
      report.editionSize !== RELEASE_EDITION_SIZE || report.manifestSha256 !== manifestSha256 ||
      report.fileSetSha256 !== fileSetSha256 || report.pinned !== true ||
      !Array.isArray(report.gateways) || report.gateways.length < 2) {
    throw new Error('IPFS pinning and two-gateway verification evidence is missing or does not match this edition.');
  }
  const hosts = new Set();
  for (const gateway of report.gateways) {
    let url;
    try { url = new URL(gateway.baseUrl); }
    catch { throw new Error('Invalid gateway base URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        gateway.manifestSha256 !== manifestSha256 || gateway.fileSetSha256 !== fileSetSha256 ||
        gateway.verifiedFiles !== RELEASE_EDITION_SIZE + 1 || gateway.failedFiles !== 0 ||
        !Number.isFinite(Date.parse(gateway.verifiedAt))) {
      throw new Error('Each HTTPS gateway must have verified every published file, without failures.');
    }
    hosts.add(url.hostname.toLowerCase());
  }
  if (hosts.size < 2) throw new Error('Use two independently operated gateway hosts.');
}

/** Pure plan assembly after the caller has verified all artwork files. No RPC or signer. */
export async function assembleReleasePlan({ verified, manifest, series, from, nonce, cid, ipfsEvidence, compiled }) {
  const publicSeries = validatePublicSeries(series);
  const sender = publicAddress(from);
  if (sender === ZeroAddress) throw new Error('A nonzero deployer address is required.');
  if (verified?.artworkVersion !== 'deltax-unique-v2' || verified.editionSize !== RELEASE_EDITION_SIZE ||
      verified.verifiedImages !== RELEASE_EDITION_SIZE || !isHash(verified.manifestSha256) ||
      manifest.editionSize !== verified.editionSize || manifest.seed !== verified.seed) {
    throw new Error('The fully verified 10000-image v2 edition must match the release parameters.');
  }
  const fileSetSha256 = publishedFileSetHash(manifest, verified.manifestSha256);
  const plan = {
    schema: 'glowpet-sepolia-release-v1', status: 'ready_for_ipfs',
    chainId: SEPOLIA_CHAIN_ID, deployer: sender,
    artwork: {
      version: verified.artworkVersion, editionSize: verified.editionSize,
      artworkSeed: verified.seed, imageSize: verified.imageSize,
      manifestSha256: verified.manifestSha256, fileSetSha256,
      verifiedImages: verified.verifiedImages, directoryCID: null,
    },
    series: publicSeries,
    initialMinted: 0,
    minting: 'Each successful claim mints one NFT; creating the series does not premint tokens.',
    transactions: null,
    feeScenarios: {
      source: '2026-11-03 local Hardhat benchmark, source commit 108e055, synthetic CID and label DeltaX, 10000 slots; not a live network quote.',
      deployGas: 3578670, createSeriesGas: 122988,
      at1GweiSepoliaETH: '0.003701658', at10GweiSepoliaETH: '0.037016580',
      excludes: 'Future claims, transfers, failed transactions, IPFS pinning and hosting.',
    },
    remaining: [
      'Persistently pin the reviewed publish/ directory and record the real directory CID.',
      'Download and hash collection.json and all portraits through two independent HTTPS gateways.',
      'Prepare unsigned transactions with the verified CID and a fresh wallet nonce.',
      'Review and sign deployment in MetaMask, then verify its receipt and deployed contract.',
      'Review and sign createSeries only after confirming the new contract parameters and ownership.',
    ],
  };
  if (!cid) {
    if (ipfsEvidence || nonce !== undefined) throw new Error('Do not supply evidence or nonce before a real CID is available.');
    return plan;
  }
  validateIpfsEvidence(ipfsEvidence, { cid, manifestSha256: verified.manifestSha256, fileSetSha256 });
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER) throw new Error('A fresh safe-integer deployment nonce is required.');
  const artifact = compiled?.artifacts?.DeltaXGlowpet;
  if (!artifact?.bytecode || artifact.bytecode === '0x' || !Array.isArray(artifact.abi)) throw new Error('Freshly compiled DeltaXGlowpet artifact is required.');
  for (const name of ['DeltaXGlowpet', 'DeltaXPortraits']) {
    const runtime = compiled.artifacts[name]?.deployedBytecode;
    if (!runtime || (runtime.length - 2) / 2 > 24576) throw new Error(`${name} exceeds the EIP-170 size limit or is missing.`);
  }
  const tx = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(cid, verified.editionSize, verified.seed);
  const expectedContract = getCreateAddress({ from: sender, nonce });
  const common = { from: sender, chainId: toQuantity(SEPOLIA_CHAIN_ID), value: '0x0' };
  plan.status = 'unsigned_transactions_prepared';
  plan.artwork.directoryCID = cid;
  plan.compiler = { version: compiled.compilerVersion, optimizerRuns: 200, viaIR: true, evmVersion: 'cancun', creationBytecodeKeccak256: keccak256(artifact.bytecode) };
  plan.expectedContract = expectedContract;
  plan.transactions = {
    deploy: { ...common, nonce: toQuantity(nonce), data: tx.data },
    createSeries: {
      ...common, to: expectedContract, nonce: toQuantity(nonce + 1),
      data: seriesInterface.encodeFunctionData('createSeries', [publicSeries.seriesId, publicSeries.maxSupply, publicSeries.salt, publicSeries.serialRoot, publicSeries.label]),
    },
  };
  plan.remaining = [
    'Recheck Sepolia chain ID, wallet account, pending nonce, balance and live gas estimates before signing.',
    'Sign deployment in MetaMask; confirm receipt.contractAddress equals expectedContract and status is successful.',
    'Read owner, artworkVersion, editionSize, artworkSeed, art and directoryURI from the new deployment.',
    'Only then recheck nonce and sign createSeries; verify series root/supply/open and minted=0.',
    'Configure the public frontend and server with the verified address and perform a controlled claim.',
  ];
  return plan;
}

function parseArgs(argv) {
  const options = {};
  const allowed = new Set(['manifest', 'series', 'from', 'out', 'cid', 'ipfs-report', 'nonce']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Use --manifest FILE --series FILE --from ADDRESS --out NEW_FILE [--cid CID --ipfs-report FILE --nonce N].');
    }
    options[key] = argv[i + 1];
  }
  for (const key of ['manifest', 'series', 'from', 'out']) if (!options[key]) throw new Error(`Missing --${key}.`);
  return options;
}

export async function prepareReleaseFiles(options) {
  // Reject malformed/public-series inputs before an expensive full-image check.
  const seriesBytes = await fs.readFile(options.series);
  const series = parseJson(seriesBytes, 'Public series metadata');
  validatePublicSeries(series);
  publicAddress(options.from);
  if (!options.cid && (options['ipfs-report'] || options.nonce !== undefined)) throw new Error('CID is required with remote evidence or nonce.');
  if (options.cid && (!options['ipfs-report'] || options.nonce === undefined)) throw new Error('A CID alone is not publication evidence: provide --ipfs-report and --nonce.');
  const verified = await verifyEdition(options.manifest);
  const manifestBytes = await fs.readFile(options.manifest);
  if (digest(manifestBytes) !== verified.manifestSha256) throw new Error('Manifest changed during verification.');
  const manifest = parseJson(manifestBytes, 'Artwork manifest');
  const ipfsEvidence = options['ipfs-report'] ? parseJson(await fs.readFile(options['ipfs-report'], 'utf8'), 'IPFS evidence') : undefined;
  // Validate supplied remote evidence before compiling, without any network requests.
  if (options.cid) validateIpfsEvidence(ipfsEvidence, { cid: options.cid, manifestSha256: verified.manifestSha256, fileSetSha256: publishedFileSetHash(manifest, verified.manifestSha256) });
  const plan = await assembleReleasePlan({
    verified, manifest, series, from: options.from,
    nonce: options.nonce === undefined ? undefined : (/^(0|[1-9][0-9]*)$/.test(String(options.nonce)) ? Number(options.nonce) : NaN),
    cid: options.cid, ipfsEvidence,
    compiled: options.cid ? compileContracts() : undefined,
  });
  plan.inputs = { seriesSha256: digest(seriesBytes) };
  plan.preparedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await fs.writeFile(options.out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = await prepareReleaseFiles(options);
    console.log(`Prepared ${plan.status}: ${path.resolve(options.out)}`);
    console.log(`Sepolia; ${plan.artwork.editionSize} claim slots; initial minted 0. No transactions were signed or sent.`);
  } catch (error) {
    console.error(`Release preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
