import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { CarIndexer } from '@ipld/car';
import { exporter } from 'ipfs-unixfs-exporter';

/** Stream an existing CAR, then read UnixFS files by indexed disk offsets (including HAMT directories). */
export async function verifyPackedCar({ carPath, inventory, draft, log = () => {}, onVerifiedFile = () => {} }) {
  assert.equal(draft.schema, 'glowpet-ipfs-publish-v1', 'Invalid packing record');
  assert.equal(draft.editionSize, inventory.manifest.editionSize);
  assert.equal(draft.manifestSha256, inventory.manifestSha256, 'Manifest differs from packing record');
  assert.equal(draft.fileSetSha256, inventory.fileSetSha256, 'File set differs from packing record');
  const expected = new Map([
    ['collection.json', inventory.manifestSha256],
    ...inventory.manifest.assets.map(asset => [asset.file, asset.sha256]),
  ]);
  const initial = await stat(carPath);
  assert.equal(initial.size, draft.carBytes, 'CAR size differs from packing record');
  const archiveHash = createHash('sha256');
  async function* chunks() {
    for await (const chunk of createReadStream(carPath, { highWaterMark: 1024 * 1024 })) {
      archiveHash.update(chunk);
      yield chunk;
    }
  }
  const indexer = await CarIndexer.fromIterable(chunks());
  assert.equal(indexer.version, 1, 'Expected CARv1');
  const roots = await indexer.getRoots();
  assert.equal(roots.length, 1, 'Expected one CAR root');
  assert.equal(roots[0].version, 1);
  assert.equal(roots[0].code, 0x70, 'Expected dag-pb root');
  assert.equal(roots[0].toString(), draft.cid, 'CAR root differs from packing record');
  const offsets = new Map();
  const duplicates = [];
  let end;
  for await (const entry of indexer) {
    assert(entry.blockLength > 0 && entry.blockLength <= 64 * 1024 * 1024, 'Invalid CAR block size');
    assert.equal(entry.cid.multihash.code, 0x12, 'Expected SHA-256 blocks');
    assert.equal(entry.cid.multihash.digest.length, 32);
    if (end !== undefined) assert.equal(entry.offset, end, 'Non-contiguous CAR sections');
    end = entry.blockOffset + entry.blockLength;
    assert.equal(end, entry.offset + entry.length);
    assert(end <= initial.size, 'CAR section extends past EOF');
    const key = entry.cid.toString();
    if (offsets.has(key)) duplicates.push(entry);
    else offsets.set(key, entry);
  }
  assert.equal(end, initial.size, 'CAR ends before the last section');
  assert.equal(archiveHash.digest('hex'), draft.carSha256, 'CAR checksum differs from packing record');
  assert(offsets.has(draft.cid), 'CAR root block is missing');
  const handle = await open(carPath, 'r');
  try {
    const reached = new Set();
    async function readBlock(entry) {
      const bytes = Buffer.allocUnsafe(entry.blockLength);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, entry.blockOffset + offset);
        assert(result.bytesRead > 0, 'Unexpected block EOF');
        offset += result.bytesRead;
      }
      const digest = createHash('sha256').update(bytes).digest();
      assert(digest.equals(Buffer.from(entry.cid.multihash.digest)), 'CAR block digest differs from its CID');
      return bytes;
    }
    const blockstore = { async get(cid) {
      const key = cid.toString();
      assert(offsets.has(key), `Missing linked block ${key}`);
      reached.add(key);
      return readBlock(offsets.get(key));
    } };
    const actual = new Set();
    const options = { blockReadConcurrency: 4 };
    async function checkFile(entry, relative) {
      assert(entry.type === 'file' || entry.type === 'raw', `Unexpected entry type at ${relative}`);
      assert(expected.has(relative) && !actual.has(relative), `Unexpected or repeated file ${relative}`);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of entry.content(options)) {
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      assert.equal(BigInt(bytes), entry.size, `Incorrect file size at ${relative}`);
      const sha256 = hash.digest('hex');
      assert.equal(sha256, expected.get(relative), `CAR contents differ at ${relative}`);
      await onVerifiedFile({ file: relative, sha256, bytes });
      actual.add(relative);
      if (actual.size % 1000 === 0) log(`  CAR readback ${actual.size}/${expected.size} files`);
    }
    const root = await exporter(draft.cid, blockstore, options);
    assert.equal(root.type, 'directory');
    const names = new Set();
    for await (const entry of root.content(options)) {
      assert(!names.has(entry.name), 'Repeated root name');
      names.add(entry.name);
      if (entry.name === 'collection.json') await checkFile(entry, entry.name);
      else {
        assert.equal(entry.name, 'portraits', 'Unexpected directory at CAR root');
        assert.equal(entry.type, 'directory');
        for await (const child of entry.content(options)) await checkFile(child, `portraits/${child.name}`);
      }
    }
    assert.deepEqual([...names].sort(), ['collection.json', 'portraits']);
    assert.equal(actual.size, expected.size, 'CAR file set is incomplete');
    for (const entry of duplicates) await readBlock(entry);
    assert.equal(reached.size, offsets.size, 'CAR contains unreachable blocks');
    const final = await handle.stat();
    assert.equal(final.size, initial.size, 'CAR changed during readback');
    assert.equal(final.mtimeMs, initial.mtimeMs, 'CAR changed during readback');
    return { rootCid: draft.cid, carBytes: initial.size, carSha256: draft.carSha256 };
  } finally {
    await handle.close();
  }
}
