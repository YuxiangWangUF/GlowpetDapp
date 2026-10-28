/** Immutable rules shared by the collection exporter and contract parity tests. */
export const ARTWORK_VERSION = 'deltax-unique-v2';
// Preserve the image ID encoding while excluding lion caps on non-cat species.
export const APPEARANCE_ID_SPACE = 20_480;
export const APPEARANCE_CAPACITY = 18_432; // (5 * 7 + 1 cat-only cap) * 8^3
export const DEFAULT_ARTWORK_SEED = '0x6c8e9cf570932bd1a6f41d05f44b13c79c37f1ce9b4b85ee719432a648382b01';
export const SPECIES = Object.freeze([
  { id: 'rabbit', name: 'Rabbit', label: '兔', code: 2 },
  { id: 'cat', name: 'Cat', label: '猫', code: 0 },
  { id: 'fox', name: 'Fox', label: '狐', code: 4 },
  { id: 'mouse', name: 'Mouse', label: '鼠', code: 9 },
  { id: 'sheep', name: 'Sheep', label: '羊', code: 7 },
].map(Object.freeze));
export const HEADWEAR = Object.freeze(['Jade Hairpin', 'Plum Blossom', 'Osmanthus Bloom', 'Silk Bow', 'Butterfly Clip', 'Cloud Comb', 'Lotus Crown', 'Lion Cap']);
export const NECKWEAR = Object.freeze(['Chinese Knot', 'Silk Scarf', 'Cloud Collar', 'Sachet', 'Jade Pendant', 'Porcelain Pendant', 'Brocade Collar', 'Longevity Lock']);
export const PALETTES = Object.freeze(['Cinnabar', 'Celadon', 'Indigo', 'Lotus', 'Amber', 'Jade', 'Wisteria', 'Pearl']);
export const MOTIFS = Object.freeze(['Cloud', 'Lotus', 'Plum', 'Bamboo', 'Waves', 'Ruyi', 'Moon', 'Koi']);
export const TRAIT_CATALOG = Object.freeze({ Headwear: HEADWEAR, Neckwear: NECKWEAR, Palette: PALETTES, Motif: MOTIFS });

export function isHeadwearAllowed(speciesIndex, headwear) {
  return Number.isInteger(speciesIndex) && speciesIndex >= 0 && speciesIndex < 5 &&
    Number.isInteger(headwear) && headwear >= 0 && headwear < 8 && (headwear !== 7 || speciesIndex === 1);
}

function integer(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) throw new RangeError(`${name} is outside the supported integer range.`);
  return value;
}

export function normalizeArtworkSeed(seed) {
  if (typeof seed !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new TypeError('Artwork seed must be exactly 32 bytes of hex.');
  return seed.toLowerCase();
}

export function permutationParameters(seed) {
  const value = BigInt(normalizeArtworkSeed(seed));
  const capacity = BigInt(APPEARANCE_CAPACITY);
  let multiplier = ((value >> 128n) % capacity) | 1n;
  // 18432 = 9 * 2^11. An odd multiplier not divisible by 3 is coprime.
  while (multiplier % 3n === 0n) multiplier = (multiplier + 2n) % capacity;
  return { multiplier: Number(multiplier), offset: Number(value % capacity) };
}

export function appearanceIdForIndex(index, seed) {
  integer(index, APPEARANCE_CAPACITY, 'Global appearance index');
  const { multiplier, offset } = permutationParameters(seed);
  // Products are < 2^29, so JS integer arithmetic is exact and matches Solidity.
  const rank = (index * multiplier + offset) % APPEARANCE_CAPACITY;
  const slot = rank % 36;
  const speciesIndex = slot === 35 ? 1 : slot % 5;
  const headwear = slot === 35 ? 7 : Math.floor(slot / 5);
  return speciesIndex + 5 * headwear + 40 * Math.floor(rank / 36);
}

export function decodeAppearance(appearanceId) {
  integer(appearanceId, APPEARANCE_ID_SPACE, 'Appearance ID');
  let remaining = appearanceId;
  const speciesIndex = remaining % 5;
  remaining = Math.floor(remaining / 5);
  const headwear = remaining % 8;
  remaining = Math.floor(remaining / 8);
  const neckwear = remaining % 8;
  remaining = Math.floor(remaining / 8);
  const palette = remaining % 8;
  const motif = Math.floor(remaining / 8);
  if (!isHeadwearAllowed(speciesIndex, headwear)) throw new RangeError('Lion Cap is exclusive to Cat.');
  return { appearanceId, speciesIndex, headwear, neckwear, palette, motif };
}

export function appearanceTraits(index, seed) {
  return decodeAppearance(appearanceIdForIndex(index, seed));
}

export function traitKey(traits) {
  const normalized = decodeAppearance(traits.appearanceId);
  for (const key of ['speciesIndex', 'headwear', 'neckwear', 'palette', 'motif']) {
    if (traits[key] !== normalized[key]) throw new Error(`Inconsistent artwork trait: ${key}`);
  }
  return [traits.speciesIndex, traits.headwear, traits.neckwear, traits.palette, traits.motif].join(':');
}

export function artworkAttributes(traits) {
  traitKey(traits);
  return [
    { trait_type: 'Species', value: SPECIES[traits.speciesIndex].name },
    { trait_type: 'Headwear', value: HEADWEAR[traits.headwear] },
    { trait_type: 'Neckwear', value: NECKWEAR[traits.neckwear] },
    { trait_type: 'Palette', value: PALETTES[traits.palette] },
    { trait_type: 'Motif', value: MOTIFS[traits.motif] },
    { trait_type: 'Appearance', value: String(traits.appearanceId) },
    { trait_type: 'Artwork', value: ARTWORK_VERSION },
  ];
}

export function validateCollectionSpec(spec) {
  if (!spec || spec.artworkVersion !== ARTWORK_VERSION) throw new Error(`Artwork version must be ${ARTWORK_VERSION}.`);
  if (!Number.isSafeInteger(spec.editionSize)) throw new TypeError('Edition size must be an integer.');
  integer(spec.editionSize - 1, APPEARANCE_CAPACITY, 'Edition size minus one');
  const seed = normalizeArtworkSeed(spec.seed);
  if (!Number.isSafeInteger(spec.imageSize) || spec.imageSize < 256 || spec.imageSize > 1254) throw new Error('Image size must be an integer between 256 and 1254.');
  return { artworkVersion: ARTWORK_VERSION, editionSize: spec.editionSize, seed, imageSize: spec.imageSize };
}

export function collectionPlan(spec) {
  const normalized = validateCollectionSpec(spec);
  return Array.from({ length: normalized.editionSize }, (_, globalIndex) => {
    const traits = appearanceTraits(globalIndex, normalized.seed);
    return { globalIndex, file: `portraits/${traits.appearanceId}.png`, traits, attributes: artworkAttributes(traits), traitKey: traitKey(traits) };
  });
}
