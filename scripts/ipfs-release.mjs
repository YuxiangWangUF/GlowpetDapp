import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createDirectoryEncoderStream, CAREncoderStream } from 'ipfs-car';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { publishedFileSetHash } from './prepare-sepolia-release.mjs';
import { uploadCarViaTus } from './ipfs-tus.mjs';

/**
 * IPFS publication helpers for the sealed 10,000-image edition.
 *
 * Everything here works on the reviewed publish/ directory (collection.json
 * plus portraits/*.png). The directory CID is computed locally, so a provider
 * can never silently publish a different tree: the upload response must match
 * the local root before anything is recorded as published.
 */

/** Root written into the CAR header first, then replaced with the real root. */
const PLACEHOLDER_CID = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');

export const PINATA_UPLOAD_SOURCE = 'glowpet-ipfs-publish-v1';

export function isDirectoryCid(value) {
  return typeof value === 'string' && /^bafy[a-z2-7]{55}$/.test(value);
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const toPosix = value => value.split(path.sep).join('/');

/**
 * Inventory the files that will be published and bind them to the manifest.
 * Every listed file must exist with the manifest hash and nothing else may be
 * present, so the uploaded tree is exactly the reviewed edition.
 */
export async function readPublishInventory(dir) {
  const manifestPath = path.join(dir, 'collection.json');
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('collection.json must list its portrait assets.');
  }
  const expected = new Map([['collection.json', manifestSha256]]);
  for (const asset of manifest.assets) {
    if (!/^portraits\/(?:0|[1-9][0-9]*)\.png$/.test(asset?.file ?? '') || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? '')) {
      throw new Error('collection.json contains an invalid published file entry.');
    }
    if (expected.has(asset.file)) throw new Error(`Duplicate manifest entry: ${asset.file}`);
    expected.set(asset.file, asset.sha256);
  }
  const present = [];
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) present.push(relative);
      else throw new Error(`Unsupported entry in publish directory: ${relative}`);
    }
  }
  await walk(dir, '');
  const missing = [...expected.keys()].filter(file => !present.includes(file));
  const unexpected = present.filter(file => !expected.has(file));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Publish directory does not match collection.json (missing: ${missing.slice(0, 3).join(', ') || 'none'}; ` +
      `unexpected: ${unexpected.slice(0, 3).join(', ') || 'none'}).`,
    );
  }
  const files = [...expected.keys()].sort();
  for (const file of files) {
    const actual = await hashFile(path.join(dir, file));
    if (actual !== expected.get(file)) throw new Error(`Hash mismatch for ${file}; refusing to publish.`);
  }
  return { dir, manifest, manifestSha256, files, fileSetSha256: publishedFileSetHash(manifest, manifestSha256) };
}

function fileLike(dir, relative, onFile) {
  return {
    name: toPosix(relative),
    stream() {
      onFile?.(relative);
      return Readable.toWeb(createReadStream(path.join(dir, relative)));
    },
  };
}

/**
 * Pack the inventory into a CARv1 whose root is the UnixFS directory that
 * contains collection.json and portraits/. The layout matches what the
 * contract expects: ipfs://<root>/portraits/<appearanceId>.png.
 */
export async function packPublishDirectory({ inventory, carPath, onProgress }) {
  await fs.mkdir(path.dirname(carPath), { recursive: true });
  const outputHandle = await fs.open(carPath, 'wx');
  let packed = 0;
  const files = inventory.files.map(file => fileLike(inventory.dir, file, () => {
    packed += 1;
    if (packed % 500 === 0) onProgress?.(packed, inventory.files.length);
  }));
  const blockStream = createDirectoryEncoderStream(files);
  const seen = new Set();
  let root;
  const uniqueBlocks = new TransformStream({
    transform(block, controller) {
      // The final input block is the root, including when it was already emitted.
      root = block.cid;
      const key = block.cid.toString();
      if (!seen.has(key)) {
        seen.add(key);
        controller.enqueue(block);
      }
    },
  });
  const carStream = new CAREncoderStream([PLACEHOLDER_CID]);
  const out = Writable.toWeb(outputHandle.createWriteStream());
  await blockStream.pipeThrough(uniqueBlocks).pipeThrough(carStream).pipeTo(out);
  if (!root) throw new Error('The CAR archive contained no blocks.');
  const handle = await fs.open(carPath, 'r+');
  try {
    await CarWriter.updateRootsInFile(handle, [root]);
  } finally {
    await handle.close();
  }
  const rootCid = root.toString();
  if (!isDirectoryCid(rootCid)) throw new Error(`Unexpected CAR root ${rootCid}; expected a CIDv1 dag-pb directory.`);
  const stat = await fs.stat(carPath);
  return { rootCid, carBytes: stat.size, carSha256: await hashFile(carPath) };
}

/** Upload a locally built CAR and require the provider to report the same root. */
export async function uploadCarToPinata(options) {
  return uploadCarViaTus(options);
}

/** Read every page of matching public records. Only non-secret identity fields leave this function. */
export async function findPinataFiles({ jwt, cid, name, pending = false, fetchImpl = fetch }) {
  const found = [];
  let pageToken;
  const pages = new Set();
  do {
    const url = new URL('https://api.pinata.cloud/v3/files/public');
    if (cid) url.searchParams.set('cid', cid);
    if (name) url.searchParams.set('name', name);
    if (pending) url.searchParams.set('cidPending', 'true');
    url.searchParams.set('limit', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url.href, {
      headers: { Authorization: `Bearer ${jwt}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Pinata listing failed (HTTP ${response.status}).`), { status: response.status });
    }
    const data = (await response.json()).data;
    if (!Array.isArray(data?.files)) throw new Error('Pinata listing response has no file list.');
    for (const file of data.files) {
      if (name && file.name !== name) continue;
      if (cid && file.cid !== cid) continue;
      found.push({ id: file.id, cid: file.cid ?? null, name: file.name, size: file.size, createdAt: file.created_at });
    }
    pageToken = data.next_page_token;
    if (pageToken && pages.has(pageToken)) throw new Error('Pinata repeated a pagination token.');
    if (pageToken) pages.add(pageToken);
  } while (pageToken);
  return found;
}

/** CAR acceptance is asynchronous. Only a subsequent public file lookup with the exact root is accepted. */
export async function waitForPinataImport({
  jwt, fileId, cid, name, onFileId = async () => {}, timeoutMs = 30 * 60_000, pollMs = 10_000,
  client, fetchImpl = fetch, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
}) {
  if (!jwt || !cid) throw new Error('PINATA_JWT and the verified CID are required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('Import wait and polling intervals must be positive.');
  }
  const deadline = now() + timeoutMs;
  async function getFile() {
    if (!fileId) {
      const matches = await findPinataFiles({ jwt, cid, name, fetchImpl });
      const match = matches.find(file => typeof file.id === 'string' && file.id);
      if (!match) return null;
      await onFileId(match.id);
      fileId = match.id;
    }
    if (client) return client.files.public.get(fileId);
    const response = await fetchImpl(`https://api.pinata.cloud/v3/files/public/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error('Pinata file lookup failed.'), { statusCode: response.status });
    }
    return (await response.json()).data;
  }
  do {
    let file;
    try {
      file = await getFile();
    } catch (error) {
      const status = error.statusCode ?? error.status;
      if (status === 401 || status === 403) throw new Error(`Pinata lookup denied (HTTP ${status}).`);
      if (status && status !== 404 && status !== 429 && status < 500) {
        throw new Error(`Pinata lookup failed (HTTP ${status}).`);
      }
      log('  Pinata file lookup temporarily unavailable; keeping the saved upload receipt.');
    }
    if (file) {
      if (file.id !== fileId) throw new Error('Pinata returned a different file id.');
      if (file.cid && file.cid !== cid) throw new Error(`Pinata reports CID ${file.cid}; expected ${cid}.`);
      if (file.cid === cid) return { id: file.id, cid: file.cid, size: file.size, createdAt: file.created_at };
      log('  Pinata CAR import is still pending.');
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, deadline - now()));
  } while (now() < deadline);
  throw new Error('Pinata CAR import is still unconfirmed. Re-run the same command to resume checking the saved file id.');
}

/** Confirm with Pinata that the recorded file id still resolves to the CID. */
export async function confirmPinataFile({ jwt, fileId, cid }) {
  if (!jwt) throw new Error('PINATA_JWT is required to confirm the pin.');
  const { PinataSDK } = await import('pinata');
  const pinata = new PinataSDK({ pinataJwt: jwt });
  const file = await pinata.files.public.get(fileId);
  if (file?.cid !== cid) throw new Error(`Pinata reports CID ${file?.cid ?? 'none'} for ${fileId}, not ${cid}.`);
  return { id: file.id, cid: file.cid, createdAt: file.created_at, size: file.size };
}

export function gatewayFileUrl(baseUrl, cid, file) {
  return `${baseUrl}/ipfs/${cid}/${file}`;
}

/** Same canonical inventory hash as publishedFileSetHash, over downloaded hashes. */
export function hashPublishedRows(rows) {
  return createHash('sha256')
    .update([...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, sha256]) => `${file}\0${sha256}\n`).join(''))
    .digest('hex');
}

/**
 * Download every published file through one HTTPS gateway and hash what was
 * actually served. Nothing is trusted from the manifest during this step.
 */
export async function verifyGateway({
  baseUrl, cid, manifest, manifestSha256, concurrency = 6, retries = 3,
  timeoutMs = 30_000, log = () => {}, cache = null, fetchImpl = fetch,
}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Gateway must be a plain HTTPS base URL: ${baseUrl}`);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const downloaded = new Map(cache ?? []);
  const entries = [['collection.json', manifestSha256], ...manifest.assets.map(a => [a.file, a.sha256])];
  let index = 0;
  let failed = 0;
  async function fetchHashed(file) {
    const target = gatewayFileUrl(base, cid, file);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${file}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        return createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw new Error(`${target}: ${lastError?.message ?? 'download failed'}`);
  }
  async function worker() {
    while (index < entries.length) {
      const [file, expected] = entries[index++];
      if (downloaded.get(file) === expected) continue;
      try {
        const actual = await fetchHashed(file);
        if (actual !== expected) throw new Error(`sha256 mismatch for ${file}`);
        downloaded.set(file, actual);
      } catch (error) {
        failed += 1;
        log(`FAILED ${baseUrl} ${error.message}`);
      }
      if ((index % 250 === 0) || index === entries.length) log(`${baseUrl}: ${index}/${entries.length} checked`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const verifiedFiles = entries.filter(([file, expected]) => downloaded.get(file) === expected).length;
  const fileSetSha256 = verifiedFiles === entries.length
    ? hashPublishedRows(entries.filter(([file, expected]) => downloaded.get(file) === expected))
    : null;
  return {
    baseUrl: base,
    manifestSha256: downloaded.get('collection.json') === manifestSha256 ? manifestSha256 : null,
    fileSetSha256,
    verifiedFiles,
    failedFiles: entries.length - verifiedFiles,
    verifiedAt: new Date().toISOString(),
    hashes: downloaded,
  };
}

/** Assemble the evidence document that prepare-sepolia-release.mjs accepts. */
export function assembleVerificationReport({ cid, editionSize, manifestSha256, fileSetSha256, gateways, pin }) {
  if (!isDirectoryCid(cid)) throw new Error('A real CIDv1 directory CID is required.');
  if (gateways.length < 2) throw new Error('At least two independently operated gateways are required.');
  if (pin?.cid !== cid || pin?.confirmed !== true) throw new Error('Pin service confirmation is required before reporting pinned=true.');
  return {
    schema: 'glowpet-ipfs-verification-v1',
    cid,
    editionSize,
    manifestSha256,
    fileSetSha256,
    pinned: true,
    pin: { provider: 'pinata', fileId: pin.fileId, cid: pin.cid, confirmedAt: pin.confirmedAt },
    gateways: gateways.map(gateway => ({
      baseUrl: gateway.baseUrl,
      manifestSha256: gateway.manifestSha256,
      fileSetSha256: gateway.fileSetSha256,
      verifiedFiles: gateway.verifiedFiles,
      failedFiles: gateway.failedFiles,
      verifiedAt: gateway.verifiedAt,
    })),
  };
}
