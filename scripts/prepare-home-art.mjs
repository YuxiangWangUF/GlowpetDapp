import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PROJECT_ROOT, verifyEdition } from './deltax-edition.mjs';
import { ARTWORK_VERSION, SPECIES } from '../shared/deltax-traits.js';
import { HOME_APPEARANCES } from '../shared/deltax-home-preview.js';

// Homepage derivatives only. Never change the frozen NFT PNGs or their manifest.
const CANVAS_SIZE = 900;
const BORDER = 30;
const ALPHA_CROP_THRESHOLD = 8;

function alphaBounds(pixels, { width, height, channels }) {
  if (channels !== 4) throw new Error('Homepage art needs an RGBA source.');
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * channels + 3] <= ALPHA_CROP_THRESHOLD) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('Homepage art source is empty.');
  // Almost invisible alpha noise outside the character is ignored; the entire
  // visible silhouette, hair accessories and hanging tassels remain in-frame.
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function assertRealDirectory(directory) {
  const entry = await fs.lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Expected a real artwork directory: ${directory}`);
}

async function assertOrdinaryOutput(file) {
  try {
    const entry = await fs.lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Refusing to replace non-file artwork output: ${file}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function prepareHomeArt() {
  const publish = path.join(PROJECT_ROOT, 'output', ARTWORK_VERSION, 'publish');
  const manifestPath = path.join(publish, 'collection.json');
  const verification = await verifyEdition(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const output = path.join(PROJECT_ROOT, 'public/pets', ARTWORK_VERSION);
  for (const directory of [path.join(PROJECT_ROOT, 'public'), path.join(PROJECT_ROOT, 'public/pets')]) {
    await assertRealDirectory(directory);
  }
  await fs.mkdir(output, { recursive: true });
  await assertRealDirectory(output);
  const results = [];
  for (const [speciesIndex, appearanceId] of HOME_APPEARANCES.entries()) {
    const asset = manifest.assets.find(item => item.traits.appearanceId === appearanceId);
    if (!asset || asset.traits.speciesIndex !== speciesIndex || asset.file !== `portraits/${appearanceId}.png`) {
      throw new Error(`Expected ${SPECIES[speciesIndex].id} appearance ${appearanceId} is missing from the verified edition.`);
    }
    const bytes = await fs.readFile(path.join(publish, asset.file));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Artwork source changed after verification.');
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bounds = alphaBounds(data, info);
    const webp = await sharp(bytes).extract(bounds)
      .resize(CANVAS_SIZE - BORDER * 2, CANVAS_SIZE - BORDER * 2, {
        fit: 'contain', position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .extend({ top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90, alphaQuality: 100, effort: 6, smartSubsample: true })
      .toBuffer();
    const metadata = await sharp(webp).metadata();
    if (metadata.width !== CANVAS_SIZE || metadata.height !== CANVAS_SIZE || !metadata.hasAlpha) throw new Error('Unexpected homepage artwork dimensions.');
    const file = path.join(output, `${appearanceId}.webp`);
    await assertOrdinaryOutput(file);
    await fs.writeFile(file, webp);
    results.push({ appearanceId, species: SPECIES[speciesIndex].id, file: path.relative(PROJECT_ROOT, file).replaceAll(path.sep, '/'), bytes: webp.length, bounds, attributes: asset.attributes });
  }
  return { verifiedNftImages: verification.verifiedImages, totalBytes: results.reduce((total, result) => total + result.bytes, 0), derivatives: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareHomeArt();
  console.log(JSON.stringify(result, null, 2));
}
