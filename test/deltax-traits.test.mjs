import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_CAPACITY, ARTWORK_VERSION, DEFAULT_ARTWORK_SEED, SPECIES, appearanceIdForIndex, appearanceTraits, decodeAppearance, traitKey, collectionPlan, validateCollectionSpec } from '../shared/deltax-traits.js';

test('all 18432 permitted trait combinations are unique for boundary and release seeds', () => {
  for (const seed of [`0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`, DEFAULT_ARTWORK_SEED]) {
    const ids = new Set(), keys = new Set();
    for (let index = 0; index < APPEARANCE_CAPACITY; index++) {
      const traits = appearanceTraits(index, seed);
      ids.add(traits.appearanceId); keys.add(traitKey(traits));
    }
    assert.equal(ids.size, APPEARANCE_CAPACITY);
    assert.equal(keys.size, APPEARANCE_CAPACITY);
  }
});

test('lion caps are exclusive to cats and every permitted combination is reachable', () => {
  const counts=Array(5).fill(0), lionCounts=Array(5).fill(0);
  for (let i=0;i<APPEARANCE_CAPACITY;i++) {
    const traits=appearanceTraits(i,DEFAULT_ARTWORK_SEED);
    counts[traits.speciesIndex]++;
    if(traits.headwear===7) lionCounts[traits.speciesIndex]++;
  }
  assert.deepEqual(counts,[3584,4096,3584,3584,3584]);
  assert.deepEqual(lionCounts,[0,512,0,0,0]);
  for(const speciesIndex of [0,2,3,4]) assert.throws(()=>decodeAppearance(speciesIndex+5*7),/exclusive/);
});

test('partial edition filenames use permuted appearance IDs and metadata matches the visible layers', () => {
  const spec = { artworkVersion: ARTWORK_VERSION, editionSize: 100, seed: DEFAULT_ARTWORK_SEED, imageSize: 1254 };
  const plan = collectionPlan(spec);
  assert.equal(plan.length, 100);
  assert.deepEqual(collectionPlan(spec), plan);
  assert.notEqual(plan[0].traits.appearanceId, 0);
  assert.equal(new Set(plan.map(x => x.file)).size, 100);
  for (const item of plan) {
    assert.equal(item.file, `portraits/${appearanceIdForIndex(item.globalIndex, spec.seed)}.png`);
    assert.equal(item.attributes.find(a => a.trait_type === 'Species').value, SPECIES[item.traits.speciesIndex].name);
  }
});

test('unsafe seeds, capacity overflow and inconsistent traits are rejected', () => {
  const spec = { artworkVersion: ARTWORK_VERSION, editionSize: 100, seed: DEFAULT_ARTWORK_SEED, imageSize: 1254 };
  for (const editionSize of [0, -1, 1.5, Infinity, APPEARANCE_CAPACITY+1, '100']) assert.throws(() => validateCollectionSpec({ ...spec, editionSize }));
  for (const seed of ['0x1', '-1', '0x' + 'z'.repeat(64), '0x' + 'a'.repeat(66)]) assert.throws(() => appearanceIdForIndex(0, seed));
  for (const index of [-1, 1.1, 20480, Number.MAX_SAFE_INTEGER]) assert.throws(() => appearanceIdForIndex(index, DEFAULT_ARTWORK_SEED));
  assert.throws(() => traitKey({ ...decodeAppearance(1), motif: 7 }));
});
