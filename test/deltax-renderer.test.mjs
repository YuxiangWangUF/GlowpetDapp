import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { loadBasePortraits, renderPortraitPng } from '../scripts/deltax-edition.mjs';
import { renderDeltaXPortrait } from '../shared/deltax-renderer.js';
import { isHeadwearAllowed } from '../shared/deltax-traits.js';

const IMAGE_SIZE = 256;
const baseTraits = Object.freeze({ speciesIndex: 0, headwear: 0, neckwear: 0, palette: 0, motif: 0 });
const bases = await loadBasePortraits();
const cache = new Map();

async function raster(traits) {
  const key = [traits.speciesIndex, traits.headwear, traits.neckwear, traits.palette, traits.motif].join(':');
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const { png } = await renderPortraitPng(traits, bases[traits.speciesIndex], IMAGE_SIZE);
      // Test the actual exported PNG, independently of SVG strings, metadata,
      // file compression, and the exporter's reported pixel checksum.
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, IMAGE_SIZE);
      assert.equal(info.height, IMAGE_SIZE);
      assert.equal(info.channels, 4);
      const visible = Buffer.from(data);
      for (let i = 0; i < visible.length; i += 4) {
        if (visible[i + 3] === 0) visible.fill(0, i, i + 3);
      }
      return { pixels: visible, sha256: createHash('sha256').update(visible).digest('hex') };
    })());
  }
  return cache.get(key);
}

function visiblyChangedPixels(left, right) {
  let changed = 0;
  for (let i = 0; i < left.length; i += 4) {
    if (left[i + 3] < 64 && right[i + 3] < 64) continue;
    const distance = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) +
      Math.abs(left[i + 2] - right[i + 2]) + Math.abs(left[i + 3] - right[i + 3]);
    if (distance > 30) changed++;
  }
  return changed;
}

for (const [speciesIndex, species] of ['rabbit', 'cat', 'fox', 'mouse', 'sheep'].entries()) {
  for (const dimension of ['headwear', 'neckwear', 'palette', 'motif']) {
    test(`${species}: permitted ${dimension} values change visible transparent PNG pixels`, { timeout: 120000 }, async () => {
      const hashes = new Set();
      const original = await raster({ ...baseTraits, speciesIndex });
      for (let value = 0; value < 8; value++) {
        if(dimension==='headwear' && !isHeadwearAllowed(speciesIndex,value)) continue;
        const image = await raster({ ...baseTraits, speciesIndex, [dimension]: value });
        assert.equal(hashes.has(image.sha256), false, `${species} ${dimension}=${value} repeats another visible portrait`);
        hashes.add(image.sha256);
        if (value !== 0) {
          assert.ok(visiblyChangedPixels(original.pixels, image.pixels) >= 16,
            `${species} ${dimension}=${value} must affect visible pixels, not only transparent RGB or metadata`);
        }
      }
      assert.equal(hashes.size, dimension==='headwear' && speciesIndex!==1 ? 7 : 8);
    });
  }
}

test('every neckwear keeps all eight embroidery motifs visible, including small pendants', { timeout: 180000 }, async () => {
  const all = new Set();
  for (let neckwear = 0; neckwear < 8; neckwear++) {
    const motifHashes = new Set();
    const original = await raster({ ...baseTraits, speciesIndex: 1, neckwear });
    for (let motif = 0; motif < 8; motif++) {
      const image = await raster({ ...baseTraits, speciesIndex: 1, neckwear, motif });
      assert.equal(motifHashes.has(image.sha256), false, `neckwear=${neckwear} obscures motif=${motif}`);
      assert.equal(all.has(image.sha256), false, `neckwear=${neckwear}, motif=${motif} duplicates a visible combination`);
      motifHashes.add(image.sha256);
      all.add(image.sha256);
      if (motif !== 0) assert.ok(visiblyChangedPixels(original.pixels, image.pixels) >= 16);
    }
    assert.equal(motifHashes.size, 8);
  }
  assert.equal(all.size, 64);
});

test('transparent exports preserve clear corners for every species and render distinct bases', async () => {
  const speciesHashes = new Set();
  const corners = [0, IMAGE_SIZE - 1, IMAGE_SIZE * (IMAGE_SIZE - 1), IMAGE_SIZE * IMAGE_SIZE - 1];
  for (let speciesIndex = 0; speciesIndex < 5; speciesIndex++) {
    const image = await raster({ ...baseTraits, speciesIndex });
    for (const pixel of corners) assert.equal(image.pixels[pixel * 4 + 3], 0, `species=${speciesIndex}, corner=${pixel}`);
    speciesHashes.add(image.sha256);
  }
  assert.equal(speciesHashes.size, 5);
});

test('a repeated render is reproducible at the decoded pixel level', async () => {
  const traits = { ...baseTraits, speciesIndex: 1, headwear: 7, neckwear: 5, palette: 6, motif: 7 };
  const first = await renderPortraitPng(traits, bases[1], IMAGE_SIZE);
  const second = await renderPortraitPng(traits, bases[1], IMAGE_SIZE);
  const left = await sharp(first.png).ensureAlpha().raw().toBuffer();
  const right = await sharp(second.png).ensureAlpha().raw().toBuffer();
  assert.deepEqual(left, right);
});

test('lion cap uses the approved plush cat asset and refuses other species', async () => {
  for(const speciesIndex of [0,2,3,4]) {
    assert.throws(()=>renderDeltaXPortrait({traits:{...baseTraits,speciesIndex,headwear:7},baseImageHref:bases[speciesIndex].href}),/exclusive/);
  }
  const traits={...baseTraits,speciesIndex:1,headwear:7};
  assert.throws(()=>renderDeltaXPortrait({traits,baseImageHref:bases[1].href}),/Approved lion-cap/);
  const svg=renderDeltaXPortrait({traits,baseImageHref:bases[1].href,lionCapImageHref:bases[1].lionCap.href});
  assert.ok(svg.includes(bases[1].lionCap.href));
  assert.equal(svg.includes(bases[1].href),false);
});

test('source image input rejects remote fetches, SVG payloads and attribute injection', () => {
  const options = { traits: baseTraits, size: IMAGE_SIZE, transparent: true };
  for (const baseImageHref of [
    'https://example.com/cat.png',
    'file:///C:/private.png',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
    'data:image/png;base64,AAAA" onload="alert(1)',
    'data:image/png;base64,AAAA</image><script>alert(1)</script>',
    '', null, undefined,
  ]) assert.throws(() => renderDeltaXPortrait({ ...options, baseImageHref }), /PNG data URI/);
});

test('renderer validates dimensions before rasterization and honors supported size boundaries', async () => {
  const options = { traits: baseTraits, baseImageHref: bases[0].href, transparent: true };
  for (const size of [0, 127, 4097, -1, 256.5, NaN, Infinity, '256', null]) {
    assert.throws(() => renderDeltaXPortrait({ ...options, size }), /image size/);
  }
  for (const size of [128, 4096]) {
    const metadata = await sharp(Buffer.from(renderDeltaXPortrait({ ...options, size }))).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }
});
