import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { publishedFileSetHash } from './prepare-sepolia-release.mjs';
import {
  isDirectoryCid, verifyGateway, assembleVerificationReport, confirmPinataFile,
} from './ipfs-release.mjs';

/**
 * Download the published edition through at least two independently operated
 * HTTPS gateways and write the evidence file for prepare-sepolia-release.mjs.
 *
 *   PINATA_JWT=... node scripts/ipfs-verify.mjs \
 *     --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
 *     --cid bafy… --publish-record deployments/…/ipfs-publish.json \
 *     --gateway https://<gateway>.mypinata.cloud --gateway https://ipfs.io \
 *     --out deployments/…/ipfs-verification.json
 *
 * Nothing is copied from the manifest into the report: each gateway row records
 * what was actually downloaded and hashed, and pinned=true requires a live
 * provider confirmation for the recorded Pinata file id.
 */

function parseArgs(argv) {
  const options = { gateways: [] };
  const allowed = new Set(['dir', 'cid', 'gateway', 'out', 'publish-record', 'concurrency', 'cache-dir']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Use --dir PUBLISH_DIR --cid CID --gateway URL (twice or more) --publish-record FILE --out NEW_FILE [--concurrency N] [--cache-dir DIR].');
    }
    if (key === 'gateway') options.gateways.push(argv[i + 1]);
    else if (options[key] !== undefined) throw new Error(`--${key} may only be given once.`);
    else options[key] = argv[i + 1];
  }
  for (const key of ['dir', 'cid', 'out', 'publish-record']) if (!options[key]) throw new Error(`Missing --${key}.`);
  if (options.gateways.length < 2) throw new Error('Two independently operated gateways are required.');
  return options;
}

async function readManifest(dir) {
  const bytes = await fs.readFile(path.join(dir, 'collection.json'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  return { manifest, manifestSha256, fileSetSha256: publishedFileSetHash(manifest, manifestSha256) };
}

async function loadCache(file) {
  try { return new Map(Object.entries(JSON.parse(await fs.readFile(file, 'utf8')))); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
}

export async function verifyPublication({ dir, cid, gateways, out, publishRecord, concurrency = 6, cacheDir, jwt, log = console.log }) {
  if (!isDirectoryCid(cid)) throw new Error('A real CIDv1 directory CID (bafy…, 59 characters) is required.');
  const { manifest, manifestSha256, fileSetSha256 } = await readManifest(path.resolve(dir));
  const record = JSON.parse(await fs.readFile(publishRecord, 'utf8'));
  if (record?.cid !== cid) throw new Error('The publication record does not describe this CID.');
  if (!record.fileId) throw new Error('The publication record has no provider file id.');

  const pin = await confirmPinataFile({ jwt, fileId: record.fileId, cid });
  log(`Pinata confirms ${pin.cid} (file ${pin.id}).`);

  const cacheRoot = path.resolve(cacheDir ?? path.dirname(path.resolve(out)));
  const results = [];
  for (const [index, gateway] of gateways.entries()) {
    const cacheFile = path.join(cacheRoot, `ipfs-verify-cache-${index}.json`);
    const cache = await loadCache(cacheFile);
    log(`Verifying through ${gateway} (${cache.size} files cached) …`);
    const result = await verifyGateway({
      baseUrl: gateway, cid, manifest, manifestSha256, concurrency, cache,
      log: message => log(`  ${message}`),
    });
    await fs.writeFile(cacheFile, JSON.stringify(Object.fromEntries(result.hashes)));
    if (result.failedFiles !== 0) {
      throw new Error(`${gateway} failed ${result.failedFiles} file(s); re-run to resume, do not publish evidence.`);
    }
    results.push(result);
    log(`  ${gateway}: ${result.verifiedFiles}/${manifest.assets.length + 1} files verified.`);
  }

  const report = assembleVerificationReport({
    cid, editionSize: manifest.editionSize, manifestSha256, fileSetSha256,
    gateways: results,
    pin: { provider: 'pinata', fileId: pin.id, cid: pin.cid, confirmed: true, confirmedAt: new Date().toISOString() },
  });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  log(`Evidence written to ${path.resolve(out)}.`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await verifyPublication({
      dir: options.dir, cid: options.cid, gateways: options.gateways, out: options.out,
      publishRecord: options['publish-record'], concurrency: Number(options.concurrency ?? 6),
      cacheDir: options['cache-dir'], jwt: process.env.PINATA_JWT,
    });
  } catch (error) {
    console.error(`IPFS verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
