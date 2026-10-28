const MAX_APPEARANCE_ID = 20_479;
const ARTWORK_NAMES = new Map([
  ["deltax-soft-v1", "DeltaX Soft & Sweet v1"],
  ["deltax-unique-v1", "DeltaX Unique v1"],
  ["deltax-unique-v2", "DeltaX Unique v2 · cat-exclusive lion cap"],
]);
const TRAIT_VALUES = new Map([
  ["Species", new Set(["Rabbit", "Cat", "Fox", "Mouse", "Sheep"])],
  ["Headwear", new Set(["Jade Hairpin", "Plum Blossom", "Osmanthus Bloom", "Silk Bow", "Butterfly Clip", "Cloud Comb", "Lotus Crown", "Lion Cap"])],
  ["Neckwear", new Set(["Chinese Knot", "Silk Scarf", "Cloud Collar", "Sachet", "Jade Pendant", "Porcelain Pendant", "Brocade Collar", "Longevity Lock"])],
  ["Palette", new Set(["Cinnabar", "Celadon", "Indigo", "Lotus", "Amber", "Jade", "Wisteria", "Pearl"])],
  ["Motif", new Set(["Cloud", "Lotus", "Plum", "Bamboo", "Waves", "Ruyi", "Moon", "Koi"])],
]);
const UNIQUE_TRAITS = ["Species", "Headwear", "Neckwear", "Palette", "Motif", "Appearance", "Stage"];

/** Resolve only the two immutable PNG path formats issued by DeltaX contracts. */
export function resolveNftImage(uri) {
  if (typeof uri !== "string") return "";
  const match = /^ipfs:\/\/(bafy[a-z2-7]{55})\/((?:rabbit|cat|fox|mouse|sheep)\.png|portraits\/(?:0|[1-9][0-9]{0,4})\.png)$/.exec(uri);
  if (!match || match[0] !== uri) return "";
  const appearance = /^portraits\/([0-9]+)\.png$/.exec(match[2]);
  if (appearance && Number(appearance[1]) > MAX_APPEARANCE_ID) return "";
  return `https://ipfs.io/ipfs/${match[1]}/${match[2]}`;
}

function numericTrait(value, maximum) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? String(value) : "";
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,4})$/.test(value) || value !== String(Number(value))) return "";
  return Number(value) <= maximum ? value : "";
}

/**
 * Read only attributes defined by these artwork versions. Values stay plain
 * React text; unknown or conflicting values are never displayed as traits.
 */
export function getDeltaXTraitRows(metadata) {
  if (!metadata || !Array.isArray(metadata.attributes) || metadata.attributes.length > 64) return null;
  const attributes = new Map();
  for (const attribute of metadata.attributes) {
    if (!attribute || typeof attribute !== "object" || typeof attribute.trait_type !== "string") continue;
    const label = attribute.trait_type;
    if (!TRAIT_VALUES.has(label) && !["Artwork", "Appearance", "Stage"].includes(label)) continue;
    // A duplicate is ambiguous even when its first occurrence looks valid.
    attributes.set(label, attributes.has(label) ? undefined : attribute.value);
  }
  const version = attributes.get("Artwork");
  if (typeof version !== "string" || !ARTWORK_NAMES.has(version)) return null;
  const labels = version.startsWith("deltax-unique-") ? UNIQUE_TRAITS : ["Species", "Stage"];
  const rows = labels.map((label) => {
    const raw = attributes.get(label);
    const value = label === "Appearance"
      ? numericTrait(raw, MAX_APPEARANCE_ID)
      : label === "Stage"
        ? numericTrait(raw, 255)
        : typeof raw === "string" && raw.length <= 64 && TRAIT_VALUES.get(label)?.has(raw) ? raw : "";
    return [label, value || "Unavailable"];
  });
  rows.push(["Artwork", ARTWORK_NAMES.get(version)], ["Storage", "IPFS · fixed portrait"]);
  return rows;
}

/** Inline SVG adapter for the existing portrait surfaces, including the garden. */
export function nftImageSvg(uri) {
  const image = resolveNftImage(uri);
  if (!image) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="DeltaX NFT portrait"><image href="${image}" width="1000" height="1000" preserveAspectRatio="xMidYMid meet"/></svg>`;
}
