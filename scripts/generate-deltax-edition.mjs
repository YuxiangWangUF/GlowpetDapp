import path from 'node:path';
import { ARTWORK_VERSION, DEFAULT_ARTWORK_SEED } from '../shared/deltax-traits.js';
import { generateEdition, verifyEdition, PROJECT_ROOT } from './deltax-edition.mjs';

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!['--out', '--supply', '--seed', '--size', '--verify'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) throw new Error('Use --out PATH --supply 100 --seed 0x… --size 1254, or --verify collection.json.');
  options[args[i]] = args[++i];
}
if (options['--verify']) {
  if (Object.keys(options).length !== 1) throw new Error('--verify cannot be mixed with export options.');
  const verified = await verifyEdition(options['--verify']);
  console.log(`Verified ${verified.verifiedImages} unique PNGs and frozen traits. Manifest SHA-256: ${verified.manifestSha256}`);
} else {
  const spec = {
    artworkVersion: ARTWORK_VERSION,
    editionSize: options['--supply'] === undefined ? 100 : Number(options['--supply']),
    seed: options['--seed'] || DEFAULT_ARTWORK_SEED,
    imageSize: options['--size'] === undefined ? 1254 : Number(options['--size']),
  };
  const result = await generateEdition({
    outputDirectory: options['--out'] || path.join(PROJECT_ROOT, 'output', ARTWORK_VERSION), spec,
    onProgress(done, total) { if (done % 10 === 0 || done === total) console.log(`Rendered and checked ${done}/${total}`); },
  });
  console.log(`Export complete: ${result.manifestPath}`);
  console.log('PNG pixels and trait combinations are unique within this edition. No IPFS upload, deployment, or mint was performed.');
}
