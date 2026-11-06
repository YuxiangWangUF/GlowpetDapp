import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { publishRelease } from '../scripts/ipfs-publish.mjs';
import { uploadCarToPinata, waitForPinataImport, hashFile, packPublishDirectory } from '../scripts/ipfs-release.mjs';
import { verifyPackedCar } from '../scripts/ipfs-car-readback.mjs';

const silent = () => {};
const digest = value => createHash('sha256').update(value).digest('hex');

test('CAR readback rejects rewritten checksums and an extra enclosing directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-car-integrity-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const dir = path.join(root, 'enclosed');
  await fs.mkdir(path.join(dir, 'portraits'), { recursive: true });
  const manifest = { editionSize: 1, assets: [{ file: 'portraits/1.png', sha256: digest('portrait') }] };
  const bytes = JSON.stringify(manifest);
  await fs.writeFile(path.join(dir, 'collection.json'), bytes);
  await fs.writeFile(path.join(dir, 'portraits/1.png'), 'portrait');
  const inventory = {
    dir, files: ['collection.json', 'portraits/1.png'], manifest,
    manifestSha256: digest(bytes), fileSetSha256: 'test-file-set',
  };
  const carPath = path.join(root, 'valid.car');
  const packed = await packPublishDirectory({ inventory, carPath });
  const draft = {
    schema: 'glowpet-ipfs-publish-v1', editionSize: 1, cid: packed.rootCid,
    carSha256: packed.carSha256, carBytes: packed.carBytes,
    manifestSha256: inventory.manifestSha256, fileSetSha256: inventory.fileSetSha256,
  };
  await verifyPackedCar({ inventory, carPath, draft });
  const corrupted = await fs.readFile(carPath);
  corrupted[corrupted.length - 1] ^= 1;
  await fs.writeFile(carPath, corrupted);
  await assert.rejects(verifyPackedCar({ inventory, carPath, draft: { ...draft, carSha256: digest(corrupted) } }), /block digest differs/);

  const wrappedCar = path.join(root, 'wrapped.car');
  const wrapped = await packPublishDirectory({
    inventory: { dir: root, files: inventory.files.map(file => `enclosed/${file}`) }, carPath: wrappedCar,
  });
  await assert.rejects(verifyPackedCar({ inventory, carPath: wrappedCar, draft: {
    ...draft, cid: wrapped.rootCid, carBytes: wrapped.carBytes, carSha256: wrapped.carSha256,
  } }), /Unexpected directory at CAR root/);
});

test('upload wrapper transfers disk bytes with explicit public CAR metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-car-upload-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const carPath = path.join(root, 'tiny.car');
  await fs.writeFile(carPath, 'test CAR input');
  let offset = 0;
  const checkpoints = [];
  const fetchImpl = async (url, request) => {
    if (request.method === 'POST') {
      assert.equal(request.headers['Upload-Length'], '14');
      assert(request.headers['Upload-Metadata'].includes('car dHJ1ZQ=='));
      assert(request.headers['Upload-Metadata'].includes('network cHVibGlj'));
      return new Response(null, { status: 201, headers: { Location: 'https://uploads.pinata.cloud/v3/files/session' } });
    }
    if (request.method === 'PATCH') {
      assert.equal(request.body.toString(), 'test CAR input');
      offset += request.body.length;
      return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });
    }
    return new Response(null, { status: 200, headers: { 'Upload-Offset': String(offset), 'Upload-Length': '14' } });
  };
  const receipt = await uploadCarToPinata({
    carPath, jwt: 'test-only', name: 'test-name', rootCid: 'test-root', fetchImpl,
    onCheckpoint: async state => checkpoints.push(state),
  });
  assert.equal(receipt.id, null);
  assert.equal(receipt.cid, null);
  assert.equal(receipt.expectedRootCid, 'test-root');
  assert.equal(receipt.transferComplete, true);
  assert.equal(checkpoints.at(-1).offset, 14);
});

test('CAR import waits through missing and pending records and fails closed on wrong roots or auth', async () => {
  let ticks = 0;
  let requests = 0;
  const cid = 'expected-root';
  const options = {
    jwt: 'test-only', fileId: 'file-1', cid, timeoutMs: 10, pollMs: 1,
    now: () => ticks, sleep: async ms => { ticks += ms; },
  };
  const client = { files: { public: { async get() {
    requests += 1;
    if (requests === 1) throw Object.assign(new Error('not indexed'), { statusCode: 404 });
    return { id: 'file-1', cid: requests === 2 ? null : cid };
  } } } };
  assert.equal((await waitForPinataImport({ ...options, client })).cid, cid);
  assert.equal(requests, 3);
  const withResult = result => ({ files: { public: { get: async () => result } } });
  await assert.rejects(waitForPinataImport({ ...options, client: withResult({ id: 'file-1', cid: 'wrong' }) }), /expected expected-root/);
  await assert.rejects(waitForPinataImport({ ...options, client: withResult({ id: 'different', cid }) }), /different file id/);
  await assert.rejects(waitForPinataImport({ ...options, client: withResult({ id: 'file-1', cid: null }) }), /still unconfirmed/);
  const denied = { files: { public: { get: async () => { throw Object.assign(new Error('denied'), { statusCode: 401 }); } } } };
  await assert.rejects(waitForPinataImport({ ...options, client: denied }), /denied/);
  const confirmed = await waitForPinataImport({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.pinata.cloud/v3/files/public/file-1');
    assert.equal(request.headers.Authorization, 'Bearer test-only');
    assert(request.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ data: { id: 'file-1', cid } }) };
  } });
  assert.equal(confirmed.cid, cid);
});

test('completed TUS upload waits for indexing and persists discovered file id before confirming it', async () => {
  let ticks = 0;
  let lists = 0;
  let persistedId;
  const result = await waitForPinataImport({
    jwt: 'test-only', cid: 'root', name: 'edition', timeoutMs: 10, pollMs: 1,
    now: () => ticks, sleep: async ms => { ticks += ms; },
    onFileId: async id => { persistedId = id; },
    fetchImpl: async url => {
      if (url.includes('?')) {
        lists += 1;
        return { ok: true, json: async () => ({ data: { files: lists === 1 ? [] : [{ id: 'indexed-file', cid: 'root', name: 'edition' }] } }) };
      }
      assert.equal(persistedId, 'indexed-file');
      return { ok: true, json: async () => ({ data: { id: 'indexed-file', cid: 'root' } }) };
    },
  });
  assert.equal(lists, 2);
  assert.equal(result.id, 'indexed-file');
});

test('existing 10000-file CAR is fully checked, retained, and resumed without duplicate submission', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-car-resume-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const dir = path.join(root, 'publish');
  await fs.mkdir(path.join(dir, 'portraits'), { recursive: true });
  const assets = [];
  for (let index = 0; index < 10_000; index++) {
    const file = `portraits/${index}.png`;
    const bytes = `portrait-${index}`;
    assets.push({ file, sha256: digest(bytes) });
    await fs.writeFile(path.join(dir, file), bytes);
  }
  await fs.writeFile(path.join(dir, 'collection.json'), JSON.stringify({ editionSize: 10_000, assets }));
  const car = path.join(root, 'edition.car');
  const reuseCar = path.join(root, 'draft.json');
  const draft = await publishRelease({ dir, car, out: reuseCar, dryRun: true, log: silent });
  const original = await fs.stat(car);
  let uploads = 0;
  let lookups = 0;
  const options = {
    dir, car, reuseCar, out: path.join(root, 'published.json'), jwt: 'test-only', log: silent,
    upload: async () => { uploads += 1; return { id: 'file-1', cid: null }; },
    waitForImport: async ({ fileId, cid }) => {
      lookups += 1;
      if (lookups === 1) throw new Error('pending import timeout');
      return { id: fileId, cid };
    },
  };
  await assert.rejects(publishRelease(options), /pending import timeout/);
  const saved = JSON.parse(await fs.readFile(`${options.out}.state.json`, 'utf8'));
  assert.equal(saved.fileId, 'file-1');
  assert.equal(saved.phase, 'submitted');
  assert(!JSON.stringify(saved).includes('test-only'));
  await assert.rejects(fs.access(options.out), { code: 'ENOENT' });
  const published = await publishRelease(options);
  assert.equal(published.cid, draft.cid);
  assert.equal(published.status, 'uploaded_pending_remote_verification');
  assert.equal(uploads, 1);
  assert.equal((await fs.stat(car)).mtimeMs, original.mtimeMs);
  assert.equal(await hashFile(car), draft.carSha256);
  await assert.rejects(publishRelease(options), /Output already exists/);
  assert.equal(uploads, 1);

  const ambiguous = { ...options, out: path.join(root, 'ambiguous.json'), upload: async () => {
    uploads += 1;
    throw new Error('connection lost after submit');
  } };
  await assert.rejects(publishRelease(ambiguous), /connection lost/);
  const uncertain = JSON.parse(await fs.readFile(`${ambiguous.out}.state.json`, 'utf8'));
  await assert.rejects(publishRelease(ambiguous), /outcome is unknown/);
  assert.equal(uploads, 2);
  const recovered = await publishRelease({ ...ambiguous, resumeFileId: 'recovered-file' });
  assert.equal(recovered.fileId, 'recovered-file');
  assert.equal(uploads, 2);

  const lockedOut = path.join(root, 'locked.json');
  await fs.writeFile(`${lockedOut}.lock`, 'another process');
  await assert.rejects(publishRelease({ ...options, out: lockedOut }), /Publication is locked/);
  assert.equal(await fs.readFile(`${lockedOut}.lock`, 'utf8'), 'another process');

  const badDraft = path.join(root, 'bad-draft.json');
  await fs.writeFile(badDraft, JSON.stringify({ ...draft, carSha256: '0'.repeat(64) }));
  await assert.rejects(publishRelease({ ...options, out: path.join(root, 'bad.json'), reuseCar: badDraft }), /CAR checksum differs/);
  assert.equal(uploads, 2);
  // A caller cannot overwrite the reusable archive by omitting the reuse option.
  await assert.rejects(publishRelease({ dir, car, out: path.join(root, 'overwrite.json'), dryRun: true, log: silent }), /EEXIST/);
  assert.equal(await hashFile(car), draft.carSha256);

  const restartOut = path.join(root, 'audited-restart.json');
  await fs.writeFile(`${restartOut}.state.json`, JSON.stringify(uncertain));
  let inspections = 0;
  await publishRelease({ ...options, out: restartOut, restartUntrackedUpload: true,
    findFiles: async () => { inspections += 1; return []; },
  });
  assert.equal(inspections, 3);
  const restarted = JSON.parse(await fs.readFile(`${restartOut}.state.json`, 'utf8'));
  assert.equal(restarted.recoveryHistory[0].previousPhase, 'submission_started');
  assert.equal(restarted.recoveryHistory[0].untrackedTusMayExist, true);

  const completeOut = path.join(root, 'completed-tus.json');
  await fs.writeFile(`${completeOut}.state.json`, JSON.stringify({
    ...uncertain, phase: 'submitted', tus: {
      phase: 'uploaded', size: draft.carBytes, offset: draft.carBytes,
      uploadUrl: 'expired-resource', rootCid: draft.cid, returnedCid: 'temporary-opaque-cid',
    },
  }));
  await publishRelease({ ...options, out: completeOut,
    upload: async () => { throw new Error('Completed transfer must not send bytes or HEAD an expired resource.'); },
    waitForImport: async ({ cid, onFileId }) => { await onFileId('indexed'); return { id: 'indexed', cid }; },
  });

  const asyncOut = path.join(root, 'async-opaque.json');
  const asynchronous = {
    ...options, out: asyncOut,
    upload: async ({ expectedSize, rootCid, onCheckpoint }) => {
      await onCheckpoint({ phase: 'uploaded', size: expectedSize, offset: expectedSize, rootCid, returnedCid: 'temporary-opaque-cid' });
      return { id: null, cid: 'temporary-opaque-cid', expectedRootCid: rootCid, transferComplete: true, size: expectedSize };
    },
    waitForImport: async ({ cid, onFileId }) => { await onFileId('final-file'); return { id: 'final-file', cid }; },
  };
  const imported = await publishRelease(asynchronous);
  assert.equal(imported.cid, draft.cid);
  const asyncState = JSON.parse(await fs.readFile(`${asyncOut}.state.json`, 'utf8'));
  assert.equal(asyncState.returnedCid, 'temporary-opaque-cid');
  const wrongOut = path.join(root, 'wrong-final-root.json');
  await assert.rejects(publishRelease({ ...asynchronous, out: wrongOut,
    waitForImport: async ({ onFileId }) => { await onFileId('final-file'); return { id: 'final-file', cid: 'wrong-final-root' }; },
  }), /confirmation differs/);
  await assert.rejects(fs.access(wrongOut), { code: 'ENOENT' });
});
