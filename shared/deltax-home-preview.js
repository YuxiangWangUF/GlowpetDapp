import { ARTWORK_VERSION, DEFAULT_ARTWORK_SEED, SPECIES, collectionPlan } from './deltax-traits.js';

const edition = collectionPlan({ artworkVersion: ARTWORK_VERSION, editionSize: 100, seed: DEFAULT_ARTWORK_SEED, imageSize: 1254 });
export const HOME_APPEARANCES = Object.freeze(SPECIES.map((_, speciesIndex) => {
  const candidates = edition.filter(asset => asset.traits.speciesIndex === speciesIndex);
  const selected = speciesIndex === 1
    ? candidates.find(asset => asset.traits.headwear === 7 && asset.traits.palette === 0) ?? candidates.find(asset => asset.traits.headwear === 7)
    : candidates.find(asset => asset.traits.headwear === (speciesIndex === 0 ? 3 : 0)) ?? candidates[0];
  if (!selected) throw new Error('Missing homepage artwork in verified edition');
  return selected.traits.appearanceId;
}));
