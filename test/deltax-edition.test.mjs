import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateEdition, verifyEdition } from '../scripts/deltax-edition.mjs';
import { ARTWORK_VERSION, DEFAULT_ARTWORK_SEED, APPEARANCE_CAPACITY } from '../shared/deltax-traits.js';

test('edition export is reproducible, complete, independently verified and cannot overwrite reviewed assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-art-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = { artworkVersion: ARTWORK_VERSION, editionSize: 5, seed: DEFAULT_ARTWORK_SEED, imageSize: 256 };
  const first = await generateEdition({ outputDirectory: path.join(root, 'first'), spec });
  const second = await generateEdition({ outputDirectory: path.join(root, 'second'), spec });
  assert.deepEqual(first.manifest, second.manifest);
  const verified = await verifyEdition(first.manifestPath);
  assert.equal(verified.verifiedImages, 5);
  assert.equal(first.manifest.uniqueTraitCount, 5);
  assert.equal(first.manifest.uniquePixelCount, 5);
  assert.equal(Object.values(first.manifest.frequencies.Species).reduce((sum,count)=>sum+count,0),5);
  assert.ok((await fs.stat(path.join(first.outputDirectory, 'preview.png'))).size > 0);
  await assert.rejects(fs.stat(path.join(first.outputDirectory, 'INCOMPLETE.txt')), { code: 'ENOENT' });
  const original = await fs.readFile(first.manifestPath);
  await assert.rejects(generateEdition({ outputDirectory: first.outputDirectory, spec }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(first.manifestPath), original);

  await fs.writeFile(path.join(first.outputDirectory, 'INCOMPLETE.txt'), 'interrupted');
  await assert.rejects(verifyEdition(first.manifestPath), /Incomplete/);
  await fs.unlink(path.join(first.outputDirectory, 'INCOMPLETE.txt'));
  for (const [key, value] of [['capacity', 1], ['rendererVersion', 'changed'], ['sources', []], ['rendererSha256', '0'.repeat(64)], ['permutation', {multiplier:1,offset:0}]]) {
    await fs.writeFile(first.manifestPath, JSON.stringify({ ...first.manifest, [key]: value }));
    await assert.rejects(verifyEdition(first.manifestPath), /frozen rules/);
  }
  await fs.writeFile(first.manifestPath, original);
  const extra = path.join(first.outputDirectory, 'publish', 'unexpected.txt');
  await fs.writeFile(extra, 'must not ship');
  await assert.rejects(verifyEdition(first.manifestPath), /Unexpected or missing files/);
  await fs.unlink(extra);

  const manifest = JSON.parse(original);
  manifest.seed = '0x' + '0'.repeat(64);
  await fs.writeFile(first.manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyEdition(first.manifestPath), /frozen rules/);
  await fs.writeFile(first.manifestPath, original);

  const file = path.join(first.outputDirectory, 'publish', first.manifest.assets[0].file);
  await fs.appendFile(file, 'altered');
  await assert.rejects(verifyEdition(first.manifestPath), /hash mismatch/);
  await fs.unlink(file);
  await assert.rejects(verifyEdition(first.manifestPath), /Unexpected or missing files/);
});

test('invalid edition configuration fails before creating an output directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowpet-invalid-art-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'must-not-exist');
  await assert.rejects(generateEdition({ outputDirectory: out, spec: { artworkVersion: ARTWORK_VERSION, editionSize: APPEARANCE_CAPACITY+1, seed: DEFAULT_ARTWORK_SEED, imageSize: 1254 } }));
  await assert.rejects(fs.stat(out), { code: 'ENOENT' });
});
