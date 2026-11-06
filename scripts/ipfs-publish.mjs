import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  readPublishInventory, packPublishDirectory, uploadCarToPinata, waitForPinataImport, findPinataFiles,
} from './ipfs-release.mjs';
import { verifyPackedCar } from './ipfs-car-readback.mjs';
import { isTusUploadExpired } from './ipfs-tus.mjs';

const FLAGS = new Set(['keep-car', 'dry-run', 'restart-untracked-upload', 'restart-expired-upload']);

function parseArgs(argv) {
  const options = {};
  const allowed = new Set(['dir', 'out', 'car', 'reuse-car', 'resume-file-id', 'wait-ms', 'name', ...FLAGS]);
  for (let i = 0; i < argv.length;) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined) {
      throw new Error('Use --dir PUBLISH_DIR --out NEW_FILE [--car FILE --reuse-car DRAFT_JSON] [--resume-file-id ID] [--wait-ms N] [--name TEXT] [--keep-car] [--dry-run].');
    }
    if (FLAGS.has(key)) {
      options[key] = true;
      i += 1;
    } else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs one value.`);
      options[key] = argv[i + 1];
      i += 2;
    }
  }
  for (const key of ['dir', 'out']) if (!options[key]) throw new Error(`Missing --${key}.`);
  return options;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Persist state before issuing a request. Ambiguous submissions require the provider file id to recover.
async function writeState(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  }
  finally { await fs.rm(temporary, { force: true }); }
}

function checkBinding(draft, inventory) {
  if (draft?.schema !== 'glowpet-ipfs-publish-v1' || draft.editionSize !== inventory.manifest.editionSize ||
      draft.manifestSha256 !== inventory.manifestSha256 || draft.fileSetSha256 !== inventory.fileSetSha256) {
    throw new Error('Saved packing/upload state does not match this reviewed edition.');
  }
}

/** Reuse a verified CAR or create a new one, persist its receipt, then check the public directory CID. */
export async function publishRelease({
  dir, out, car, reuseCar, resumeFileId, restartUntrackedUpload, restartExpiredUpload, waitMs = 30 * 60_000, name, keepCar, dryRun, jwt,
  log = console.log, upload = uploadCarToPinata, waitForImport = waitForPinataImport, findFiles = findPinataFiles,
  checkExpired = isTusUploadExpired,
}) {
  if (!dryRun && !jwt) throw new Error('PINATA_JWT is required in the shell environment.');
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('--wait-ms must be positive.');
  if (reuseCar && !car) throw new Error('--reuse-car DRAFT_JSON requires --car EXISTING_FILE.');
  if (dryRun && resumeFileId) throw new Error('--resume-file-id requires a live import check.');
  const output = path.resolve(out);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Publication is locked: ${lockPath}. After confirming its recorded process has stopped, remove only that lock to retry.`);
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    try {
      await fs.access(output);
      throw new Error(`Output already exists: ${output}. Inspect the existing publication record.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const statePath = `${output}.state.json`;
    let state = await readJson(statePath);
    if (state && (state.schema !== 'glowpet-ipfs-upload-state-v1' || dryRun)) {
      throw new Error('Existing upload state cannot be used for this command.');
    }
    const inventory = await readPublishInventory(path.resolve(dir));
    log(`Reviewed ${inventory.files.length} files; manifest ${inventory.manifestSha256}; file set ${inventory.fileSetSha256}`);
    const carPath = path.resolve(car ?? state?.carPath ?? path.join(path.dirname(output), 'edition.car'));
    if (carPath === output || (reuseCar && path.resolve(reuseCar) === output)) throw new Error('Output must be separate from CAR and draft.');
    if (state && state.carPath !== carPath) throw new Error('CAR path differs from the saved upload state.');
    let draft = state?.draft;
    if (reuseCar) {
      const supplied = await readJson(path.resolve(reuseCar));
      if (supplied?.status !== 'packed_not_uploaded') throw new Error('--reuse-car requires a packed_not_uploaded draft record.');
      checkBinding(supplied, inventory);
      if (draft && ['cid', 'carSha256', 'carBytes'].some(key => supplied[key] !== draft[key])) {
        throw new Error('Supplied draft differs from the saved upload state.');
      }
      draft = supplied;
    }
    if (draft) {
      checkBinding(draft, inventory);
      log(`Reading back every file from existing CAR ${carPath} …`);
      await verifyPackedCar({ carPath, inventory, draft, log });
    } else {
      log(`Packing new CAR ${carPath} …`);
      const packed = await packPublishDirectory({
        inventory, carPath, onProgress: (done, total) => log(`  packed ${done}/${total} files`),
      });
      draft = {
        schema: 'glowpet-ipfs-publish-v1', status: 'packed_not_uploaded', provider: null,
        cid: packed.rootCid, editionSize: inventory.manifest.editionSize,
        manifestSha256: inventory.manifestSha256, fileSetSha256: inventory.fileSetSha256,
        carSha256: packed.carSha256, carBytes: packed.carBytes, packedAt: new Date().toISOString(),
      };
    }
    log(`CAR root ${draft.cid} (${draft.carBytes} bytes)`);
    if (dryRun) {
      await writeState(output, draft, true);
      log(`Local packing/readback record written to ${output}.`);
      return draft;
    }
    if (!state) {
      state = {
        schema: 'glowpet-ipfs-upload-state-v1', phase: 'prepared', draft, carPath,
        retainCar: Boolean(keepCar || reuseCar), name: name ?? `glowpet-deltax-unique-v2-${draft.cid}`,
      };
      await writeState(statePath, state);
    }
    if (resumeFileId) {
      if (state.fileId && state.fileId !== resumeFileId) throw new Error('Recovery file id differs from the saved receipt.');
      state = { ...state, phase: 'submitted', fileId: resumeFileId };
      await writeState(statePath, state);
    }
    if (state.tus?.phase === 'uploaded' && (state.tus.offset !== draft.carBytes || state.tus.size !== draft.carBytes ||
        (state.tus.rootCid && state.tus.rootCid !== draft.cid))) {
      throw new Error('Saved TUS completion receipt does not match the complete verified CAR.');
    }
    if (!state.fileId) {
      let expired = false;
      if (restartExpiredUpload && state.tus?.uploadUrl && state.tus.phase !== 'uploaded') {
        expired = await checkExpired({ jwt, location: state.tus.uploadUrl });
        if (!expired) throw new Error('The saved TUS resource still exists. Resume it without the restart option.');
      }
      if (expired || (state.phase !== 'prepared' && !state.tus?.uploadUrl && restartUntrackedUpload)) {
        const [rootMatches, named, pending] = await Promise.all([
          findFiles({ jwt, cid: draft.cid }),
          findFiles({ jwt, name: state.name }),
          findFiles({ jwt, name: state.name, pending: true }),
        ]);
        const existing = rootMatches.find(file => file.cid === draft.cid && file.id);
        if (existing) {
          state = { ...state, phase: 'submitted', fileId: existing.id };
        } else {
          if (named.length || pending.length) throw new Error('Account inspection found related files. Resolve their status before creating another upload.');
          state = {
            ...state, phase: 'prepared', tus: null,
            recoveryHistory: [...(state.recoveryHistory ?? []), {
              previousPhase: state.phase, previousTus: state.tus ?? null, previousStartedAt: state.startedAt,
              checkedAt: new Date().toISOString(), matchingPublicFiles: 0,
              decision: expired ? 'expired_tus_restart_after_account_inspection' : 'explicit_restart_after_account_inspection',
              untrackedTusMayExist: !expired,
            }],
          };
        }
        await writeState(statePath, state);
      }
      if (!state.fileId && state.phase !== 'prepared' && !state.tus?.uploadUrl) {
        throw new Error('Previous upload outcome is unknown. Check Pinata Files, then use --resume-file-id ID to check the existing upload. Do not resubmit blindly.');
      }
    }
    if (!state.fileId && state.tus?.phase !== 'uploaded') {
      state = { ...state, phase: 'submission_started', startedAt: new Date().toISOString() };
      await writeState(statePath, state);
      log('Uploading the CAR to Pinata with public network and car=true …');
      const receipt = await upload({
        carPath, jwt, name: state.name, rootCid: draft.cid, expectedSize: draft.carBytes, state: state.tus,
        onCheckpoint: async tus => {
          state = { ...state, phase: tus.phase === 'uploaded' ? 'transferred' : 'transferring', tus };
          await writeState(statePath, state);
        },
        onProgress: event => log(`  ${event.phase}: ${event.uploadedBytes ?? 0}/${event.bytes} bytes${event.chunkBytes ? `; chunk ${event.chunkBytes}` : ''}`),
      });
      const hasId = typeof receipt?.id === 'string' && receipt.id;
      if (!hasId && (!receipt?.transferComplete || receipt?.expectedRootCid !== draft.cid ||
          receipt?.size !== draft.carBytes || state.tus?.phase !== 'uploaded')) {
        throw new Error('Upload has no durable complete TUS receipt. Inspect the saved state before retrying.');
      }
      state = {
        ...state, phase: 'submitted', fileId: receipt.id ?? null,
        returnedCid: receipt.cid ?? null, acceptedAt: new Date().toISOString(),
      };
      await writeState(statePath, state);
    }
    log(`Waiting for Pinata CAR import for ${draft.cid} …`);
    const confirmed = await waitForImport({
      jwt, fileId: state.fileId, cid: draft.cid, name: state.name, timeoutMs: waitMs, log,
      onFileId: async fileId => {
        state = { ...state, fileId };
        await writeState(statePath, state);
      },
    });
    if (confirmed.id !== state.fileId || confirmed.cid !== draft.cid) throw new Error('Pinata import confirmation differs from the expected file id or CID.');
    const record = {
      ...draft, status: 'uploaded_pending_remote_verification', provider: 'pinata', fileId: state.fileId,
      uploadedAt: state.acceptedAt ?? confirmed.createdAt ?? new Date().toISOString(),
      providerCidConfirmedAt: new Date().toISOString(),
    };
    await writeState(output, record, true);
    if (!keepCar && !reuseCar && !state.retainCar) await fs.rm(carPath);
    log(`Recorded ${output}. Next run scripts/ipfs-verify.mjs with two gateways.`);
    return record;
  } finally {
    await lock.close();
    await fs.rm(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await publishRelease({
      dir: options.dir, out: options.out, car: options.car, name: options.name,
      reuseCar: options['reuse-car'], resumeFileId: options['resume-file-id'],
      restartUntrackedUpload: options['restart-untracked-upload'],
      restartExpiredUpload: options['restart-expired-upload'],
      waitMs: Number(options['wait-ms'] ?? 30 * 60_000),
      keepCar: options['keep-car'], dryRun: options['dry-run'], jwt: process.env.PINATA_JWT,
    });
  } catch (error) {
    const message = process.env.PINATA_JWT ? error.message.replaceAll(process.env.PINATA_JWT, '[redacted]') : error.message;
    console.error(`IPFS publication failed: ${message}`);
    process.exitCode = 1;
  }
}
