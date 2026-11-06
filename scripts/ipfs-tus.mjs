import { open } from 'node:fs/promises';

const ENDPOINT = 'https://uploads.pinata.cloud/v3/files';

function uploadUrl(value) {
  const url = new URL(value, ENDPOINT);
  if (url.protocol !== 'https:' || url.hostname !== 'uploads.pinata.cloud' || url.port || url.username || url.password || url.hash) {
    throw new Error('Pinata returned an untrusted TUS upload location.');
  }
  return url.href;
}

function numberHeader(response, name) {
  const value = response.headers.get(name);
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '')) throw new Error(`Missing or invalid TUS ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Unsafe TUS ${name}.`);
  return number;
}

function httpError(response, method) {
  const error = new Error(`Pinata TUS request failed (${method}, HTTP ${response.status}).`);
  error.status = response.status;
  return error;
}

async function rejectionDetail(response, jwt) {
  const parts = [];
  let remaining = 4096;
  if (response.body) {
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk).subarray(0, remaining);
      parts.push(part);
      remaining -= part.length;
      if (remaining === 0) break;
    }
  }
  const raw = Buffer.concat(parts).toString('utf8');
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    message = [parsed.code, parsed.message, parsed.errorMessage, parsed.error?.code, parsed.error?.message, parsed.error]
      .filter(value => typeof value === 'string').join(' ') || raw;
  } catch { /* Some gateways send a short HTML error page. */ }
  return message.replaceAll(jwt, '[redacted]').replace(/https?:\/\/[^\s"<>]+/g, '[url]')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);
}

/** A missing/expired resource can be replaced only after a separate account inspection. */
export async function isTusUploadExpired({ jwt, location, fetchImpl = fetch }) {
  const response = await fetchImpl(uploadUrl(location), {
    method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${jwt}`, 'Tus-Resumable': '1.0.0' },
  });
  try {
    if ([404, 410].includes(response.status)) return true;
    if (response.ok) return false;
    throw httpError(response, 'HEAD');
  } finally { await response.body?.cancel(); }
}

/** Disk-backed TUS transport. All offsets are safe integers and every accepted offset is durably checkpointed. */
export async function uploadCarViaTus({
  carPath, jwt, name, rootCid, expectedSize, state = null, onCheckpoint, onProgress = () => {},
  fetchImpl = fetch, chunkSize = 16 * 1024 * 1024, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!jwt || !rootCid || typeof onCheckpoint !== 'function') throw new Error('TUS upload requires JWT, root CID and a durable checkpoint callback.');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 32 * 1024 * 1024) throw new Error('Invalid upload chunk size.');
  const handle = await open(carPath, 'r');
  try {
    const initial = await handle.stat();
    const size = initial.size;
    if (!Number.isSafeInteger(size) || size <= 0 || (expectedSize !== undefined && size !== expectedSize)) throw new Error('CAR size differs from the verified upload size.');
    if (state && (state.size !== size || (state.rootCid && state.rootCid !== rootCid))) throw new Error('Saved TUS state belongs to a different CAR.');
    let current = state;
    let transferChunkSize = Math.min(chunkSize, state?.chunkSize ?? chunkSize);
    if (!Number.isSafeInteger(transferChunkSize) || transferChunkSize <= 0) throw new Error('Invalid saved TUS chunk size.');
    async function checkpoint(update) {
      current = { ...current, ...update, size, rootCid };
      try { await onCheckpoint(current); }
      catch { throw Object.assign(new Error('Could not durably save the upload checkpoint. Stop and inspect storage before resuming.'), { fatal: true }); }
    }
    async function request(url, options, timeoutMs = 30_000) {
      return fetchImpl(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${jwt}`, 'Tus-Resumable': '1.0.0', ...options.headers },
      });
    }
    async function head() {
      for (let attempt = 0; attempt < 6; attempt++) {
        let response;
        try {
          onProgress({ phase: 'tus-head', bytes: size, uploadedBytes: current.offset ?? 0 });
          response = await request(current.uploadUrl, { method: 'HEAD' });
          if (!response.ok) throw httpError(response, 'HEAD');
          const length = numberHeader(response, 'Upload-Length');
          const offset = numberHeader(response, 'Upload-Offset');
          if (length !== size || offset > size) throw Object.assign(new Error('Remote TUS length/offset differs from this CAR.'), { fatal: true });
          return offset;
        } catch (error) {
          if (error.fatal || (error.status && error.status !== 429 && error.status < 500)) throw error;
          if (attempt === 5) throw new Error('Pinata TUS HEAD could not confirm the saved upload. Resume the same state later.');
          await sleep(Math.min(1000 * 2 ** attempt, 10_000));
        } finally { await response?.body?.cancel(); }
      }
    }
    if (!current?.uploadUrl) {
      if (current) throw new Error('Previous TUS creation outcome is unknown. Inspect the account before authorizing a new resource.');
      await checkpoint({ phase: 'creation_started', offset: 0 });
      const metadata = Object.entries({ filename: name, filetype: 'application/vnd.ipld.car', network: 'public', car: 'true' })
        .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`).join(',');
      let response;
      try {
        response = await request(ENDPOINT, { method: 'POST', headers: { 'Upload-Length': String(size), 'Upload-Metadata': metadata } });
        if (response.status !== 201) throw httpError(response, 'POST');
        const location = response.headers.get('Location');
        if (!location) throw new Error('Pinata accepted creation without a TUS Location.');
        await checkpoint({ phase: 'uploading', uploadUrl: uploadUrl(location), offset: 0 });
        onProgress({ phase: 'tus-created', bytes: size, uploadedBytes: 0 });
      } catch (error) {
        if (error.fatal) throw error;
        throw new Error(`TUS creation did not produce a durable upload location${error.status ? ` (HTTP ${error.status})` : ''}. Check the saved state before retrying.`);
      } finally { await response?.body?.cancel(); }
    } else {
      current = { ...current, uploadUrl: uploadUrl(current.uploadUrl) };
    }
    let offset = await head();
    await checkpoint({ phase: offset === size ? 'uploaded' : 'uploading', offset });
    onProgress({ phase: 'upload-start', bytes: size, uploadedBytes: offset });
    while (offset < size) {
      const snapshot = await handle.stat();
      if (snapshot.size !== size || snapshot.mtimeMs !== initial.mtimeMs) throw new Error('CAR changed during upload.');
      const bytes = Buffer.allocUnsafe(Math.min(transferChunkSize, size - offset));
      let read = 0;
      while (read < bytes.length) {
        const part = await handle.read(bytes, read, bytes.length - read, offset + read);
        if (!part.bytesRead) throw new Error('Unexpected EOF while reading the CAR.');
        read += part.bytesRead;
      }
      let sent = false;
      for (let attempt = 0; attempt < 6 && !sent; attempt++) {
        let response;
        try {
          if (offset === 0) onProgress({ phase: 'tus-patch', bytes: size, uploadedBytes: offset, chunkBytes: bytes.length });
          response = await request(current.uploadUrl, {
            method: 'PATCH', headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: bytes,
          }, 300_000);
          if (response.status !== 204) {
            const error = httpError(response, 'PATCH');
            if (response.status === 413) {
              error.detail = await rejectionDetail(response, jwt);
              if (/Upload-Length exceeds maximum upload size/i.test(error.detail)) {
                error.message = `Pinata rejected the complete CAR size (PATCH, HTTP 413). ${error.detail}`;
                error.fatal = true;
              }
            }
            throw error;
          }
          const next = numberHeader(response, 'Upload-Offset');
          if (next !== offset + bytes.length) throw Object.assign(new Error('Unexpected TUS offset after PATCH.'), { fatal: true });
          const returnedCid = response.headers.get('upload-cid');
          await checkpoint({ phase: next === size ? 'uploaded' : 'uploading', offset: next, returnedCid: returnedCid || current.returnedCid || null });
          offset = next;
          sent = true;
        } catch (error) {
          if (error.fatal || (error.status && ![409, 413, 429].includes(error.status) && error.status < 500)) throw error;
          // An interrupted response can follow a successful PATCH. Ask the server before resending bytes.
          const confirmed = await head();
          if (confirmed < offset || confirmed > offset + bytes.length) throw new Error('TUS offset changed outside the submitted chunk.');
          await checkpoint({ phase: confirmed === size ? 'uploaded' : 'uploading', offset: confirmed });
          if (confirmed > offset) {
            offset = confirmed;
            sent = true;
          } else if (error.status === 413) {
            if (bytes.length <= 1024 * 1024) {
              throw new Error(`Pinata rejected a chunk of at most 1 MiB (HTTP 413). Inspect account/upload limits before resuming. ${error.detail || 'No error detail returned.'}`);
            }
            transferChunkSize = Math.max(1024 * 1024, Math.floor(bytes.length / 2));
            await checkpoint({ chunkSize: transferChunkSize });
            onProgress({ phase: 'chunk-size-reduced', bytes: size, uploadedBytes: offset, chunkBytes: transferChunkSize });
            sent = true;
          } else {
            if (attempt === 5) throw new Error('TUS chunk retries exhausted. The saved upload can be resumed.');
            await sleep(Math.min(1000 * 2 ** attempt, 10_000));
          }
        } finally { await response?.body?.cancel(); }
      }
      onProgress({ phase: 'upload-progress', bytes: size, uploadedBytes: offset });
    }
    // Every offset above came from a successful PATCH or reconciled HEAD. A final
    // PATCH can start asynchronous import and retire the TUS resource immediately.
    await checkpoint({ phase: 'uploaded', offset: size });
    return { id: null, cid: current.returnedCid ?? null, expectedRootCid: rootCid, transferComplete: true, size };
  } finally { await handle.close(); }
}
