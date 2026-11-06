import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { createDirectoryEncoderStream, CAREncoderStream } from 'ipfs-car';
import { CarReader, CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { packPublishDirectory, hashPublishedRows } from '../scripts/ipfs-release.mjs';
import { verifyPackedCar } from '../scripts/ipfs-car-readback.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const placeholder = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');

test('packing deduplicates shared blocks while preserving distinct files and the original root', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-car-dedup-'));
  t.after(() => fs.rm(temporary, { recursive: true }));
  const dir = path.join(temporary, 'publish');
  await fs.mkdir(path.join(dir, 'portraits'), { recursive: true });
  const sharedChunk = Buffer.alloc(1024 * 1024, 37);
  const bodies = [Buffer.concat([sharedChunk, Buffer.from('first-tail')]), Buffer.concat([sharedChunk, Buffer.from('second-tail')])];
  const assets = [];
  for (const [index, bytes] of bodies.entries()) {
    const file = `portraits/${index}.png`;
    await fs.writeFile(path.join(dir, file), bytes);
    assets.push({ file, sha256: hash(bytes) });
  }
  assert.notEqual(assets[0].sha256, assets[1].sha256, 'The fixture files must differ');
  const manifest = { editionSize: assets.length, assets };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, 'collection.json'), manifestBytes);
  const manifestSha256 = hash(manifestBytes);
  const inventory = {
    dir, manifest, manifestSha256, files: ['collection.json', ...assets.map(asset => asset.file)],
    fileSetSha256: hashPublishedRows([['collection.json', manifestSha256], ...assets.map(asset => [asset.file, asset.sha256])]),
  };

  // Baseline is the original encoder without a duplicate filter.
  const originalPath = path.join(temporary, 'original.car');
  const encoder = new CAREncoderStream([placeholder]);
  const files = inventory.files.map(file => ({
    name: file, stream: () => Readable.toWeb(createReadStream(path.join(dir, file))),
  }));
  await createDirectoryEncoderStream(files).pipeThrough(encoder)
    .pipeTo(Writable.toWeb(createWriteStream(originalPath, { flags: 'wx' })));
  const originalRoot = encoder.finalBlock.cid;
  const handle = await fs.open(originalPath, 'r+');
  try { await CarWriter.updateRootsInFile(handle, [originalRoot]); }
  finally { await handle.close(); }

  const carPath = path.join(temporary, 'deduplicated.car');
  const packed = await packPublishDirectory({ inventory, carPath });
  assert.equal(packed.rootCid, originalRoot.toString());
  assert(packed.carBytes < (await fs.stat(originalPath)).size);
  const original = await CarReader.fromBytes(await fs.readFile(originalPath));
  const actual = await CarReader.fromBytes(await fs.readFile(carPath));
  const originalBlocks = [];
  const actualBlocks = new Map();
  for await (const block of original.blocks()) originalBlocks.push(block);
  for await (const block of actual.blocks()) {
    const key = block.cid.toString();
    assert(!actualBlocks.has(key), 'The new CAR must have no duplicate records');
    actualBlocks.set(key, block.bytes);
  }
  assert(originalBlocks.length > actualBlocks.size);
  for (const block of originalBlocks) assert.deepEqual(actualBlocks.get(block.cid.toString()), block.bytes);
  assert.equal((await actual.getRoots())[0].toString(), originalRoot.toString());
  const verifiedRows = [];
  const result = await verifyPackedCar({ carPath, inventory, onVerifiedFile: row => verifiedRows.push(row), draft: {
    schema: 'glowpet-ipfs-publish-v1', editionSize: assets.length,
    cid: packed.rootCid, carBytes: packed.carBytes, carSha256: packed.carSha256,
    manifestSha256, fileSetSha256: inventory.fileSetSha256,
  } });
  assert.equal(result.rootCid, originalRoot.toString());
  assert.equal(verifiedRows.length, inventory.files.length);
  assert.deepEqual(verifiedRows.map(row => [row.file, row.sha256]).sort(),
    [['collection.json', manifestSha256], ...assets.map(asset => [asset.file, asset.sha256])].sort());
  assert.equal(verifiedRows.reduce((bytes, row) => bytes + row.bytes, 0), manifestBytes.length + bodies.reduce((bytes, body) => bytes + body.length, 0));
});
