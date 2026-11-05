import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPublishInventory, packPublishDirectory, uploadCarToPinata, isDirectoryCid,
} from './ipfs-release.mjs';

/**
 * Publish the sealed publish/ directory to Pinata.
 *
 *   PINATA_JWT=... node scripts/ipfs-publish.mjs \
 *     --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
 *     --out deployments/sepolia-10000-20261103/ipfs-publish.json
 *
 * The directory CID is computed locally from the reviewed files; the upload
 * only succeeds when Pinata reports the same root. The record written here is
 * not verification evidence on its own: scripts/ipfs-verify.mjs must re-confirm
 * the pin and download every file through two gateways.
 */

const FLAGS = new Set(['keep-car', 'dry-run']);

function parseArgs(argv) {
  const options = {};
  const allowed = new Set(['dir', 'out', 'car', 'name', 'keep-car', 'dry-run']);
  for (let i = 0; i < argv.length;) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key)) {
      throw new Error('Use --dir PUBLISH_DIR --out NEW_FILE [--car FILE] [--name TEXT] [--keep-car] [--dry-run].');
    }
    if (FLAGS.has(key)) {
      options[key] = true;
      i += 1;
      continue;
    }
    if (options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`--${key} needs exactly one value.`);
    }
    options[key] = argv[i + 1];
    i += 2;
  }
  for (const key of ['dir', 'out']) if (!options[key]) throw new Error(`Missing --${key}.`);
  return options;
}

export async function publishRelease({ dir, out, car, name, keepCar, dryRun, jwt, log = console.log }) {
  if (!dryRun && !jwt) throw new Error('PINATA_JWT is required; it must stay in the shell environment, never in a file.');
  if (!dryRun && typeof fs.openAsBlob !== 'function') throw new Error('This Node.js build lacks fs.openAsBlob; use Node.js 24.');
  const inventory = await readPublishInventory(path.resolve(dir));
  log(`Reviewed ${inventory.files.length} files; manifest ${inventory.manifestSha256.slice(0, 12)}…; file set ${inventory.fileSetSha256.slice(0, 12)}…`);

  const carPath = path.resolve(car ?? path.join(path.dirname(path.resolve(out)), 'edition.car'));
  log(`Packing ${carPath} …`);
  const packed = await packPublishDirectory({
    inventory, carPath,
    onProgress: (done, total) => log(`  packed ${done}/${total} files`),
  });
  log(`CAR root ${packed.rootCid} (${packed.carBytes} bytes)`);

  if (!isDirectoryCid(packed.rootCid)) throw new Error('Local packing did not produce a directory CID.');
  if (dryRun) {
    const draft = {
      schema: 'glowpet-ipfs-publish-v1',
      status: 'packed_not_uploaded',
      provider: null,
      cid: packed.rootCid,
      editionSize: inventory.manifest.editionSize,
      manifestSha256: inventory.manifestSha256,
      fileSetSha256: inventory.fileSetSha256,
      carSha256: packed.carSha256,
      carBytes: packed.carBytes,
      packedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    log(`Dry run: no upload. Draft record ${path.resolve(out)} is not publication evidence.`);
    return draft;
  }
  log('Uploading to Pinata (resumable, car=true) …');
  const upload = await uploadCarToPinata({
    carPath, jwt, name: name ?? `glowpet-deltax-unique-v2-${packed.rootCid}`,
    onProgress: event => log(`  ${event.phase}${event.bytes ? ` (${event.bytes} bytes)` : ''}`),
  });
  if (upload.cid !== packed.rootCid) {
    throw new Error(`Pinata returned ${upload.cid} but the local tree is ${packed.rootCid}; nothing was recorded.`);
  }
  const record = {
    schema: 'glowpet-ipfs-publish-v1',
    status: 'uploaded_pending_remote_verification',
    provider: 'pinata',
    fileId: upload.id,
    cid: packed.rootCid,
    editionSize: inventory.manifest.editionSize,
    manifestSha256: inventory.manifestSha256,
    fileSetSha256: inventory.fileSetSha256,
    carSha256: packed.carSha256,
    carBytes: packed.carBytes,
    uploadedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (!keepCar) {
    await fs.rm(carPath, { force: true });
    log('Removed the local CAR; pass --keep-car to keep it for re-uploads.');
  }
  log(`Recorded ${path.resolve(out)}. Next: scripts/ipfs-verify.mjs with two gateways.`);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await publishRelease({
      dir: options.dir, out: options.out, car: options.car, name: options.name,
      keepCar: options['keep-car'], dryRun: options['dry-run'], jwt: process.env.PINATA_JWT,
    });
  } catch (error) {
    console.error(`IPFS publication failed: ${error.message}`);
    process.exitCode = 1;
  }
}
