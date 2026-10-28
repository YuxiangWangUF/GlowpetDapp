import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ARTWORK_VERSION, APPEARANCE_CAPACITY, SPECIES, TRAIT_CATALOG, validateCollectionSpec, collectionPlan, permutationParameters } from '../shared/deltax-traits.js';
import { renderDeltaXPortrait, DELTAX_RENDERER_VERSION } from '../shared/deltax-renderer.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function artworkProvenance() {
  const digestSource = async name => hash((await fs.readFile(path.join(PROJECT_ROOT, 'shared', name), 'utf8')).replace(/\r\n/g, '\n'));
  return { rendererSha256: await digestSource('deltax-renderer.js'), rulesSha256: await digestSource('deltax-traits.js') };
}

export async function loadBasePortraits(sourceDirectory = path.join(PROJECT_ROOT, 'public/pets/deltax-soft-v1')) {
  const portraits = [];
  for (const species of SPECIES) {
    const file = `${species.id}.png`;
    const bytes = await fs.readFile(path.join(sourceDirectory, file));
    const meta = await sharp(bytes).metadata();
    if (meta.format !== 'png' || meta.width !== 1254 || meta.height !== 1254 || !meta.hasAlpha) throw new Error(`Unexpected approved base portrait: ${file}`);
    const portrait = { file, sha256: hash(bytes), bytes: bytes.length, href: `data:image/png;base64,${bytes.toString('base64')}` };
    if (species.id === 'cat') {
      const lionBytes = await fs.readFile(path.join(PROJECT_ROOT, 'public/pets/deltax-wardrobe-v2/cat-lion-cap.png'));
      const lionMeta = await sharp(lionBytes).metadata();
      if (lionMeta.format !== 'png' || lionMeta.width !== 1254 || lionMeta.height !== 1254 || !lionMeta.hasAlpha) throw new Error('Unexpected approved lion-cap cat.');
      portrait.lionCap = { file: 'deltax-wardrobe-v2/cat-lion-cap.png', sha256: hash(lionBytes), bytes: lionBytes.length, href: `data:image/png;base64,${lionBytes.toString('base64')}` };
    }
    portraits.push(portrait);
  }
  return portraits;
}

function sourceMetadata({ href, lionCap, ...source }) {
  if (!lionCap) return source;
  const { href: lionHref, ...variant } = lionCap;
  return { ...source, lionCap: variant };
}

function canonicalPixels(data) {
  // Invisible RGB under fully transparent pixels cannot count as a unique look.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  }
  return data;
}

export async function renderPortraitPng(traits, base, imageSize) {
  const svg = renderDeltaXPortrait({ traits, baseImageHref: base.href, lionCapImageHref: base.lionCap?.href, size: imageSize, transparent: true });
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== imageSize || info.height !== imageSize || info.channels !== 4) throw new Error('Unexpected renderer dimensions.');
  canonicalPixels(data);
  const pixelSha256 = hash(data);
  const png = await sharp(data, { raw: info }).png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
  return { png, pixelSha256 };
}

function frequencyReport(assets) {
  const result = { Species: Object.fromEntries(SPECIES.map(s => [s.name, 0])) };
  for (const [type, values] of Object.entries(TRAIT_CATALOG)) result[type] = Object.fromEntries(values.map(value => [value, 0]));
  for (const asset of assets) for (const a of asset.attributes) if (result[a.trait_type]) result[a.trait_type][a.value]++;
  return result;
}

function previewHtml(manifest) {
  const speciesFilters = SPECIES.map(s => `<button type="button" data-filter="${s.name}">${s.label}</button>`).join('');
  const cards = manifest.assets.map(asset => {
    const values = Object.fromEntries(asset.attributes.map(a => [a.trait_type, a.value]));
    return `<article class="card" data-species="${xml(values.Species)}"><img loading="lazy" src="publish/${asset.file}" alt="${xml(Object.values(values).join(', '))}"><div class="caption"><span class="edition">NO. ${String(asset.globalIndex + 1).padStart(3, '0')}</span><h2>${SPECIES[asset.traits.speciesIndex].label} · ${xml(values.Palette)}</h2><p>${xml(values.Headwear)} · ${xml(values.Neckwear)}</p><p class="fine">${xml(values.Motif)} · 外观 ${asset.traits.appearanceId}</p></div></article>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glowpet · 中国风独特立绘</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f7f3ec;color:#463b35;font-family:system-ui,"Microsoft YaHei",sans-serif}header,main{max-width:1420px;margin:auto;padding:42px 28px}header{padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:3px;color:#9b784c}h1{font-family:Georgia,"Songti SC",serif;font-size:clamp(30px,5vw,58px);font-weight:500;margin:18px 0}header p{max-width:780px;line-height:1.8;color:#85766c}nav{display:flex;gap:9px;flex-wrap:wrap;margin-top:24px}button{border:1px solid #dfd2bf;border-radius:25px;background:transparent;color:inherit;padding:8px 24px;cursor:pointer}button[aria-pressed=true]{background:#625749;color:#fff9ec;border-color:#625749}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:22px}.card{background:linear-gradient(135deg,#fffdf8,#f2ece1);border:1px solid #e9dfd1;border-radius:22px;overflow:hidden}.card img{display:block;width:100%;aspect-ratio:1;object-fit:contain}.caption{padding:0 21px 22px}.edition{font-size:10px;letter-spacing:2px;color:#a18869}h2{font-size:17px;font-weight:500;margin:8px 0}.caption p{font-size:11px;line-height:1.8;margin:4px 0;color:#786b5e}.fine{opacity:.7}.count{font-size:12px;color:#9b784c;margin-bottom:18px}.card[hidden]{display:none}footer{padding:34px;text-align:center;font-size:12px;color:#a29586}
  </style><header><div class="eyebrow">GLOWPET · CHINESE WARDROBE</div><h1>每一只，都有自己的装扮。</h1><p>五款软糯伙伴，搭配玉簪、绒花、中国结、云肩与丝绸。${manifest.editionSize} 套固定组合已生成并检查重复；这里展示的是本地立绘，尚未发行。</p><nav><button type="button" data-filter="all" aria-pressed="true">全部</button>${speciesFilters}</nav></header><main><div class="count" id="count">${manifest.editionSize} 个独特组合</div><div class="grid">${cards}</div></main><footer>配饰与纹饰保持不变 · 成长只改变状态</footer><script>
  const cards=[...document.querySelectorAll('.card')];document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));let n=0;cards.forEach(c=>{c.hidden=b.dataset.filter!=='all'&&c.dataset.species!==b.dataset.filter;if(!c.hidden)n++});document.getElementById('count').textContent=n+' 个独特组合'}));
  </script></html>`;
}

export async function writeContactSheet(directory, manifest) {
  const count = Math.min(manifest.assets.length, 20);
  const columns = 5, cell = 300, header = 130, caption = 43;
  // Sample each species for a useful overview of the restricted headwear set.
  const groups = SPECIES.map((_, speciesIndex) => manifest.assets.filter(asset => asset.traits.speciesIndex === speciesIndex));
  const selected = [];
  for (let round = 0; selected.length < count && round < manifest.assets.length; round++) {
    for (const group of groups) if (group[round] && selected.length < count) selected.push(group[round]);
  }
  const rows = Math.ceil(count / columns);
  const layers = [];
  let labels = `<text x="40" y="53" font-family="Georgia,serif" font-size="32" fill="#584935">GLOWPET · CHINESE WARDROBE</text><text x="42" y="91" font-family="sans-serif" font-size="17" fill="#9a8163">${manifest.editionSize} unique looks · Local preview · Not minted</text>`;
  for (let i = 0; i < selected.length; i++) {
    const asset = selected[i];
    const left = i % columns * cell, top = header + Math.floor(i / columns) * (cell + caption);
    layers.push({ input: await sharp(path.join(directory, 'publish', asset.file)).resize(cell, cell).png().toBuffer(), left, top });
    labels += `<text x="${left + 24}" y="${top + cell + 17}" font-family="sans-serif" font-size="12" fill="#907a61">NO. ${String(asset.globalIndex + 1).padStart(3, '0')} · ${xml(SPECIES[asset.traits.speciesIndex].name)} · #${asset.traits.appearanceId}</text>`;
  }
  const width = columns * cell, height = header + rows * (cell + caption) + 20;
  layers.push({ input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width, height, channels: 4, background: '#faf5ed' } }).composite(layers).png().toFile(path.join(directory, 'preview.png'));
}

export async function generateEdition({ outputDirectory, spec, onProgress = () => {} }) {
  const config = validateCollectionSpec(spec);
  const plan = collectionPlan(config);
  const bases = await loadBasePortraits();
  const out = path.resolve(outputDirectory);
  // Never overwrite an already reviewed edition. Failed exports remain clearly
  // incomplete, without collection.json, for inspection rather than deletion.
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, 'INCOMPLETE.txt'), 'Do not publish this folder until collection.json and verification succeed.\n', { flag: 'wx' });
  await fs.mkdir(path.join(out, 'publish/portraits'), { recursive: true });
  const assets = [], hashes = new Set(), keys = new Set();
  for (const entry of plan) {
    const { png, pixelSha256 } = await renderPortraitPng(entry.traits, bases[entry.traits.speciesIndex], config.imageSize);
    if (hashes.has(pixelSha256) || keys.has(entry.traitKey)) throw new Error(`Duplicate visible portrait or trait combination at allocation ${entry.globalIndex}. Export stopped.`);
    hashes.add(pixelSha256); keys.add(entry.traitKey);
    await fs.writeFile(path.join(out, 'publish', entry.file), png, { flag: 'wx' });
    assets.push({ ...entry, bytes: png.length, sha256: hash(png), pixelSha256 });
    onProgress(assets.length, config.editionSize);
  }
  const manifest = {
    schemaVersion: 1, status: 'export_complete_not_uploaded_or_deployed',
    ...config, capacity: APPEARANCE_CAPACITY, rendererVersion: DELTAX_RENDERER_VERSION,
    permutation: permutationParameters(config.seed), uniquenessScope: 'one contract / edition, across all its series',
    ...await artworkProvenance(),
    renderer: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
    sources: bases.map(sourceMetadata),
    uniqueTraitCount: keys.size, uniquePixelCount: hashes.size,
    frequencies: frequencyReport(assets), assets,
  };
  const manifestPath = path.join(out, 'publish/collection.json');
  const pendingManifestPath = path.join(out, 'publish/collection.pending.json');
  await fs.writeFile(pendingManifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await checkEdition(pendingManifestPath, true);
  await fs.writeFile(path.join(out, 'index.html'), previewHtml(manifest), { flag: 'wx' });
  await writeContactSheet(out, manifest);
  await fs.rename(pendingManifestPath, manifestPath);
  await fs.unlink(path.join(out, 'INCOMPLETE.txt'));
  return { outputDirectory: out, manifestPath, editionSize: config.editionSize, manifest };
}

export async function verifyEdition(manifestPath) {
  return checkEdition(manifestPath, false);
}

async function checkEdition(manifestPath, building) {
  const file = path.resolve(manifestPath);
  const publish = path.dirname(file);
  if (path.basename(file) !== (building ? 'collection.pending.json' : 'collection.json')) throw new Error('Unexpected artwork manifest filename.');
  if (!building) {
    try {
      await fs.stat(path.join(publish, '..', 'INCOMPLETE.txt'));
      throw new Error('Incomplete artwork export; do not publish.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const folder of [publish, path.join(publish, 'portraits')]) {
    const info = await fs.lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Artwork folders must be real directories.');
  }
  const stat = await fs.stat(file);
  if (stat.size > 30 * 1024 * 1024) throw new Error('Oversized artwork manifest.');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const config = validateCollectionSpec(manifest);
  if (manifest.schemaVersion !== 1 || manifest.status !== 'export_complete_not_uploaded_or_deployed') throw new Error('Incomplete or unsupported artwork export.');
  const sources = (await loadBasePortraits()).map(sourceMetadata);
  const provenance = await artworkProvenance();
  if (manifest.capacity !== APPEARANCE_CAPACITY || manifest.rendererVersion !== DELTAX_RENDERER_VERSION ||
      JSON.stringify(manifest.permutation) !== JSON.stringify(permutationParameters(config.seed)) ||
      manifest.rendererSha256 !== provenance.rendererSha256 || manifest.rulesSha256 !== provenance.rulesSha256 ||
      JSON.stringify(manifest.renderer) !== JSON.stringify({ sharp: sharp.versions.sharp, vips: sharp.versions.vips }) ||
      JSON.stringify(manifest.sources) !== JSON.stringify(sources)) throw new Error('Artwork frozen rules, renderer or approved sources do not match.');
  const plan = collectionPlan(config);
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== plan.length) throw new Error('Artwork file count does not match edition size.');
  const topFiles = (await fs.readdir(publish)).sort();
  const portraitFiles = (await fs.readdir(path.join(publish, 'portraits'))).sort();
  if (JSON.stringify(topFiles) !== JSON.stringify([path.basename(file), 'portraits'].sort()) ||
      JSON.stringify(portraitFiles) !== JSON.stringify(plan.map(p => path.basename(p.file)).sort())) throw new Error('Unexpected or missing files in the publish directory.');
  const hashes = new Set(), keys = new Set();
  for (let i = 0; i < plan.length; i++) {
    const expected = plan[i], asset = manifest.assets[i];
    for (const key of ['globalIndex', 'file', 'traits', 'attributes', 'traitKey']) {
      if (JSON.stringify(asset[key]) !== JSON.stringify(expected[key])) throw new Error(`Artwork manifest differs from frozen rules at index ${i}.`);
    }
    const imagePath = path.join(path.dirname(file), expected.file);
    if ((await fs.lstat(imagePath)).isSymbolicLink()) throw new Error('Artwork files cannot be symlinks.');
    const bytes = await fs.readFile(imagePath);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error(`Artwork file hash mismatch: ${expected.file}`);
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== config.imageSize || info.height !== config.imageSize || info.channels !== 4) throw new Error(`Wrong artwork dimensions: ${expected.file}`);
    const pixels = hash(canonicalPixels(data));
    if (pixels !== asset.pixelSha256 || hashes.has(pixels) || keys.has(asset.traitKey)) throw new Error(`Duplicate or altered artwork: ${expected.file}`);
    hashes.add(pixels); keys.add(asset.traitKey);
  }
  if (manifest.uniquePixelCount !== hashes.size || manifest.uniqueTraitCount !== keys.size ||
      JSON.stringify(manifest.frequencies) !== JSON.stringify(frequencyReport(manifest.assets))) throw new Error('Incorrect artwork uniqueness or frequency report.');
  return { ...config, manifestSha256: hash(await fs.readFile(file)), verifiedImages: hashes.size };
}
