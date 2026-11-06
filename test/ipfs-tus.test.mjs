import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { uploadCarViaTus, isTusUploadExpired } from '../scripts/ipfs-tus.mjs';

const cid = 'bafybeiel5kxwyulqcsyd6tqb42scbs5ij57sn2yfj63w73spu2iwg7fqvm';
const uploadUrl = 'https://uploads.pinata.cloud/v3/files/test-session';
const boundary = 2 ** 32;
const sleep = async () => {};
test('expired-resource restart requires a fresh trusted HEAD with 404 or 410', async () => {
  for (const status of [404, 410, 200]) {
    const expired = await isTusUploadExpired({ jwt: 'test-only', location: uploadUrl,
      fetchImpl: async (url, request) => {
        assert.equal(url, uploadUrl);
        assert.equal(request.method, 'HEAD');
        assert.equal(request.redirect, 'error');
        return new Response(null, { status });
      },
    });
    assert.equal(expired, status !== 200);
  }
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(isTusUploadExpired({ jwt: 'test-only', location: uploadUrl,
      fetchImpl: async () => new Response(null, { status }),
    }), /Pinata TUS request failed/);
  }
  await assert.rejects(isTusUploadExpired({ jwt: 'test-only', location: 'https://other.example/session',
    fetchImpl: async () => { throw new Error('Must reject before sending credentials.'); },
  }), /untrusted/);
});
const headResponse = (offset, size) => new Response(null, {
  status: 200, headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(size) },
});
const patchResponse = offset => new Response(null, {
  status: 204, headers: { 'Upload-Offset': String(offset) },
});

async function fixture(t, bytes, sparseOffset = 0) {
  const base = path.resolve('.glowpet-local-demo');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'ipfs-tus-regression-'));
  t.after(async () => {
    assert(path.resolve(dir).startsWith(base + path.sep));
    await fs.rm(dir, { recursive: true });
  });
  const carPath = path.join(dir, 'fixture.car');
  const file = await fs.open(carPath, 'wx+');
  try {
    if (sparseOffset && process.platform === 'win32') {
      const result = spawnSync('fsutil.exe', ['sparse', 'setflag', carPath], { windowsHide: true, encoding: 'utf8' });
      assert.equal(result.status, 0, 'Windows must mark the fixture sparse before extending beyond 4 GiB.');
    }
    await file.truncate(sparseOffset + bytes.length);
    await file.write(bytes, 0, bytes.length, sparseOffset);
  } finally { await file.close(); }
  return { carPath, size: sparseOffset + bytes.length };
}

function options(file, extra = {}) {
  return { ...file, jwt: 'disposable-test-token', rootCid: cid, name: 'transport-regression',
    chunkSize: 16, sleep, onCheckpoint: async () => {}, ...extra };
}

test('TUS preserves a >4 GiB length and reads the correct bytes across the 32-bit boundary', async t => {
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuv');
  const file = await fixture(t, bytes, boundary - 4);
  let remote = boundary - 4;
  const checkpoints = [];
  const sent = [];
  const receipt = await uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    onCheckpoint: async state => { checkpoints.push(structuredClone(state)); },
    fetchImpl: async (url, request) => {
      assert.equal(String(url), uploadUrl);
      const headers = new Headers(request.headers);
      assert.equal(headers.get('Tus-Resumable'), '1.0.0');
      if (request.method === 'HEAD') return headResponse(remote, file.size);
      assert.equal(request.method, 'PATCH', 'A resumed upload must not create another resource.');
      assert.equal(Number(headers.get('Upload-Offset')), remote);
      const body = Buffer.from(request.body);
      assert(body.length <= 16);
      assert.deepEqual(body, bytes.subarray(remote - (boundary - 4), remote - (boundary - 4) + body.length));
      sent.push(body);
      remote += body.length;
      return patchResponse(remote);
    },
  }));
  assert.equal(remote, file.size);
  assert.deepEqual(Buffer.concat(sent), bytes);
  assert.equal(receipt.id, null, 'Final TUS success may precede a Pinata file id.');
  assert.equal(receipt.cid, null);
  assert.equal(receipt.expectedRootCid, cid);
  assert.equal(receipt.transferComplete, true);
  assert.equal(receipt.size, file.size);
  assert.equal(checkpoints.at(-1).phase, 'uploaded');
  assert.equal(checkpoints.at(-1).offset, file.size);
});

test('TUS creation sends the full >4 GiB length and checkpoints Location before bytes', async t => {
  const file = await fixture(t, Buffer.from('tail'), boundary + 7);
  let created = 0;
  let checkpoint;
  await assert.rejects(uploadCarViaTus(options(file, {
    onCheckpoint: async state => {
      checkpoint = structuredClone(state);
      if (state.uploadUrl) throw new Error('simulated process stop after saving Location');
    },
    fetchImpl: async (url, request) => {
      assert.equal(checkpoint.phase, 'creation_started');
      assert.equal(request.method, 'POST');
      created++;
      const headers = new Headers(request.headers);
      assert.equal(headers.get('Upload-Length'), String(boundary + 11));
      const metadata = Object.fromEntries(headers.get('Upload-Metadata').split(',').map(pair => {
        const [key, value] = pair.trim().split(' ');
        return [key, Buffer.from(value, 'base64').toString('utf8')];
      }));
      assert.equal(metadata.network, 'public');
      assert.equal(metadata.car, 'true');
      return new Response(null, { status: 201, headers: { Location: uploadUrl } });
    },
  })), /durably save the upload checkpoint/);
  assert.equal(created, 1);
  assert.equal(checkpoint.uploadUrl, uploadUrl);
  assert.equal(checkpoint.size, file.size);
});

test('TUS recovers a lost PATCH response with HEAD and does not resend accepted bytes', async t => {
  const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
  const file = await fixture(t, bytes);
  let remote = 0;
  let failedOnce = false;
  const sentOffsets = [];
  await uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    fetchImpl: async (url, request) => {
      if (request.method === 'HEAD') return headResponse(remote, file.size);
      assert.equal(request.method, 'PATCH');
      const offset = Number(new Headers(request.headers).get('Upload-Offset'));
      assert.equal(offset, remote);
      sentOffsets.push(offset);
      remote += request.body.length;
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('connection lost after server accepted the chunk');
      }
      return patchResponse(remote);
    },
  }));
  assert.deepEqual(sentOffsets, [0, 16]);
  assert.equal(remote, file.size);
});

test('TUS retries 429 and reconciles a 409 offset through HEAD', async t => {
  const file = await fixture(t, Buffer.from('abcdefghijklmnopqrstuvwx'));
  let remote = 0;
  let patches = 0;
  const offsets = [];
  await uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    fetchImpl: async (url, request) => {
      if (request.method === 'HEAD') return headResponse(remote, file.size);
      assert.equal(request.method, 'PATCH');
      patches++;
      const offset = Number(new Headers(request.headers).get('Upload-Offset'));
      offsets.push(offset);
      if (patches === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
      if (patches === 2) {
        remote = 8;
        return new Response(null, { status: 409 });
      }
      assert.equal(offset, remote);
      assert.equal(Buffer.from(request.body).toString(), 'ijklmnopqrstuvwx');
      remote += request.body.length;
      return patchResponse(remote);
    },
  }));
  assert.deepEqual(offsets, [0, 0, 8]);
  assert.equal(remote, file.size);
});

test('TUS completed uploads and uncertain creation do not trigger another POST', async t => {
  const file = await fixture(t, Buffer.from('already sent'));
  const calls = [];
  const receipt = await uploadCarViaTus(options(file, {
    state: { phase: 'uploaded', uploadUrl, offset: file.size, size: file.size },
    fetchImpl: async (url, request) => {
      calls.push(request.method);
      assert.equal(request.method, 'HEAD');
      return headResponse(file.size, file.size);
    },
  }));
  assert.equal(receipt.size, file.size);
  assert(calls.length > 0 && calls.every(method => method === 'HEAD'));
  await assert.rejects(uploadCarViaTus(options(file, {
    state: { phase: 'creation_started', offset: 0, size: file.size },
    fetchImpl: async () => assert.fail('Unknown POST outcome requires reconciliation.'),
  })));
});

test('TUS fails closed on expired resources, invalid offsets and untrusted upload URLs', async t => {
  const file = await fixture(t, Buffer.from('remaining bytes'));
  for (const status of [404, 410]) {
    const methods = [];
    await assert.rejects(uploadCarViaTus(options(file, {
      state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
      fetchImpl: async (url, request) => {
        methods.push(request.method);
        return new Response(null, { status });
      },
    })));
    assert(methods.every(method => method === 'HEAD'));
  }
  await assert.rejects(uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    fetchImpl: async () => headResponse(file.size + 1, file.size),
  })));
  await assert.rejects(uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl: 'https://untrusted.example/upload', offset: 0, size: file.size },
    fetchImpl: async () => assert.fail('Never send the bearer token to an untrusted server.'),
  })));
  await assert.rejects(uploadCarViaTus(options(file, {
    state: { phase: 'uploaded', uploadUrl, offset: file.size, size: file.size, rootCid: 'wrong-root', returnedCid: 'opaque-container' },
    fetchImpl: async () => assert.fail('A saved mismatched expected root must fail before any network request.'),
  })), /different CAR/);
});

test('TUS retains a temporary opaque header CID and accepts the final durable 204 without another HEAD', async t => {
  const file = await fixture(t, Buffer.from('transfer'));
  const methods = [];
  const checkpoints = [];
  const receipt = await uploadCarViaTus(options(file, {
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    onCheckpoint: async state => checkpoints.push(structuredClone(state)),
    fetchImpl: async (url, request) => {
      methods.push(request.method);
      if (request.method === 'HEAD') {
        return methods.length === 1 ? headResponse(0, file.size) : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 204, headers: {
        'Upload-Offset': String(file.size), 'upload-cid': 'temporary-opaque-cid',
      } });
    },
  }));
  assert.deepEqual(methods, ['HEAD', 'PATCH']);
  assert.equal(receipt.cid, 'temporary-opaque-cid');
  assert.equal(receipt.expectedRootCid, cid);
  assert.equal(receipt.transferComplete, true);
  assert.equal(checkpoints.at(-1).phase, 'uploaded');
  assert.equal(checkpoints.at(-1).offset, file.size);
  assert.equal(checkpoints.at(-1).returnedCid, 'temporary-opaque-cid');
});

test('TUS reduces a rejected 2 MiB chunk to 1 MiB within the same upload resource', async t => {
  const mebibyte = 1024 * 1024;
  const file = await fixture(t, Buffer.alloc(2 * mebibyte, 37));
  let posts = 0;
  let remote = 0;
  const patchLengths = [];
  const checkpoints = [];
  await uploadCarViaTus(options(file, {
    chunkSize: 2 * mebibyte,
    onCheckpoint: async state => checkpoints.push(structuredClone(state)),
    fetchImpl: async (url, request) => {
      const headers = new Headers(request.headers);
      if (request.method === 'POST') {
        posts++;
        assert.equal(headers.get('Upload-Length'), String(2 * mebibyte));
        return new Response(null, { status: 201, headers: { Location: uploadUrl } });
      }
      assert.equal(String(url), uploadUrl);
      if (request.method === 'HEAD') return headResponse(remote, file.size);
      assert.equal(request.method, 'PATCH');
      assert.equal(Number(headers.get('Upload-Offset')), remote);
      patchLengths.push(request.body.length);
      if (request.body.length > mebibyte) return new Response('chunk too large', { status: 413 });
      remote += request.body.length;
      return patchResponse(remote);
    },
  }));
  assert.equal(posts, 1);
  assert.equal(remote, file.size);
  assert.deepEqual(patchLengths, [2 * mebibyte, mebibyte, mebibyte]);
  assert(checkpoints.some(state => state.chunkSize === mebibyte));
  assert(checkpoints.every(state => state.size === file.size));
});

test('TUS stops after a 1 MiB rejection and exposes bounded diagnostics without JWT or URLs', async t => {
  const file = await fixture(t, Buffer.alloc(1024 * 1024, 37));
  const jwt = 'disposable-test-token';
  const sensitiveUrl = 'https://uploads.pinata.cloud/private-session?token=secret';
  let patches = 0;
  await assert.rejects(uploadCarViaTus(options(file, {
    chunkSize: 1024 * 1024,
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    fetchImpl: async (url, request) => {
      if (request.method === 'HEAD') return headResponse(0, file.size);
      assert.equal(request.method, 'PATCH');
      patches++;
      return new Response(JSON.stringify({
        code: 'UPLOAD_QUOTA_EXCEEDED',
        errorMessage: 'Upload-Length exceeds maximum upload size. Upload quota exceeded. Bearer ' + jwt + ' at ' + sensitiveUrl,
      }), { status: 413, headers: { 'Content-Type': 'application/json' } });
    },
  })), error => {
    assert.match(error.message, /413/);
    assert.match(error.message, /UPLOAD_QUOTA_EXCEEDED/);
    assert.match(error.message, /Upload quota exceeded/);
    assert.match(error.message, /Upload-Length exceeds maximum upload size/);
    assert(!error.message.includes(jwt));
    assert(!error.message.includes(sensitiveUrl));
    assert(!error.message.includes('https://'));
    assert(error.message.length < 1000);
    return true;
  });
  assert.equal(patches, 1);
});

test('TUS uses 16 MiB by default and stops a total-size rejection without retrying or reducing chunks', async t => {
  const file = await fixture(t, Buffer.alloc(17 * 1024 * 1024, 37));
  const requests = [];
  await assert.rejects(uploadCarViaTus(options(file, {
    chunkSize: undefined,
    state: { phase: 'uploading', uploadUrl, offset: 0, size: file.size },
    fetchImpl: async (url, request) => {
      requests.push(request.method);
      if (request.method === 'HEAD') {
        return requests.length === 1 ? headResponse(0, file.size) : new Response(null, { status: 404 });
      }
      assert.equal(request.method, 'PATCH');
      assert.equal(request.body.length, 16 * 1024 * 1024);
      return new Response(JSON.stringify({ errorMessage: 'Upload-Length exceeds maximum upload size' }), {
        status: 413, headers: { 'Content-Type': 'application/json' },
      });
    },
  })), /complete CAR size.*413.*Upload-Length exceeds maximum upload size/);
  assert.deepEqual(requests, ['HEAD', 'PATCH']);
});
