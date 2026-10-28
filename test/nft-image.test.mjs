import test from "node:test";
import assert from "node:assert/strict";
import { getDeltaXTraitRows, nftImageSvg, resolveNftImage } from "../src/nft-image.js";
import { decodeTokenURI } from "../src/contract.js";

const cid = "bafy" + "a".repeat(55);
test("five IPFS portraits adapt to all existing SVG display surfaces", () => {
  for (const model of ["rabbit", "cat", "fox", "mouse", "sheep"]) {
    const image = `ipfs://${cid}/${model}.png`;
    assert.equal(resolveNftImage(image), `https://ipfs.io/ipfs/${cid}/${model}.png`);
    const uri = "data:application/json;base64," + Buffer.from(JSON.stringify({ image })).toString("base64");
    assert.equal(decodeTokenURI(uri).svg, nftImageSvg(image));
    assert.match(decodeTokenURI(uri).svg, /<image href="https:/);
  }
});
test("portrait adapter rejects script URLs, injected attributes and unknown assets", () => {
  for (const uri of [null, "javascript:alert(1)", `ipfs://${cid}/cat.png\" onload=\"alert(1)`, `ipfs://${cid}/../cat.png`, `ipfs://${cid}/dog.png`]) {
    assert.equal(nftImageSvg(uri), "");
  }
});

test("unique portraits resolve their canonical appearance IDs at both collection boundaries", () => {
  for (const appearance of [0, 1, 99, 20_479]) {
    const image = `ipfs://${cid}/portraits/${appearance}.png`;
    assert.equal(resolveNftImage(image), `https://ipfs.io/ipfs/${cid}/portraits/${appearance}.png`);
    const metadata = { image, attributes: [{ trait_type: "Artwork", value: "deltax-unique-v1" }] };
    const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(metadata)).toString("base64");
    assert.equal(decodeTokenURI(uri).image, image);
    assert.equal(decodeTokenURI(uri).svg, nftImageSvg(image));
  }
});

test("unique portrait paths reject aliases, out-of-range IDs and URL or SVG injection", () => {
  const invalid = [
    "portraits/20480.png", "portraits/999999999999999999999.png", "portraits/-1.png",
    "portraits/00.png", "portraits/01.png", "portraits/+1.png", "portraits/1.0.png",
    "portraits/1e2.png", "portraits/%31.png", "portraits/١.png", "portraits/1.PNG",
    "portraits/1.png?query=1", "portraits/1.png#fragment", "portraits/1.png/",
    "portraits/../cat.png", "portraits%2f1.png", "portraits\\1.png", "portraits//1.png",
    'portraits/1.png" onload="alert(1)', "portraits/1.svg", "0.png",
    "portraits/1.png\n", "portraits/1.png\r\n", "cat.png\n",
  ];
  for (const file of invalid) {
    assert.equal(resolveNftImage(`ipfs://${cid}/${file}`), "", file);
    assert.equal(nftImageSvg(`ipfs://${cid}/${file}`), "", file);
  }
  for (const uri of [`https://ipfs.io/ipfs/${cid}/portraits/1.png`, `ipfs://${cid.toUpperCase()}/portraits/1.png`, `ipfs://${cid}@evil.example/portraits/1.png`]) {
    assert.equal(resolveNftImage(uri), "");
  }
});

function uniqueMetadata(overrides = []) {
  return { attributes: [
    ["Artwork", "deltax-unique-v1"], ["Species", "Rabbit"], ["Headwear", "Jade Hairpin"],
    ["Neckwear", "Chinese Knot"], ["Palette", "Celadon"], ["Motif", "Lotus"],
    ["Appearance", "0"], ["Stage", "0"],
  ].map(([trait_type, value]) => ({ trait_type, value })).concat(overrides) };
}

test("detail traits use unique artwork metadata, including numeric zero and the full accessory catalog", () => {
  const rows = new Map(getDeltaXTraitRows(uniqueMetadata()));
  assert.equal(rows.get("Headwear"), "Jade Hairpin");
  assert.equal(rows.get("Neckwear"), "Chinese Knot");
  assert.equal(rows.get("Palette"), "Celadon");
  assert.equal(rows.get("Appearance"), "0");
  assert.equal(rows.get("Stage"), "0");
  assert.equal(rows.has("Eyes"), false);
  const numeric = uniqueMetadata();
  numeric.attributes.find(a => a.trait_type === "Appearance").value = 20479;
  numeric.attributes.find(a => a.trait_type === "Stage").value = 255;
  assert.equal(new Map(getDeltaXTraitRows(numeric)).get("Appearance"), "20479");
  assert.equal(new Map(getDeltaXTraitRows(numeric)).get("Stage"), "255");
});

test("metadata parser rejects ambiguous, invalid and attacker-supplied attributes without inventing traits", () => {
  const metadata = uniqueMetadata([
    { trait_type: "Headwear", value: "Lion Cap" },
    { trait_type: "Headwear", value: "Jade Hairpin" },
    { trait_type: "Untrusted label", value: "<script>" },
    null,
  ]);
  metadata.attributes.find(a => a?.trait_type === "Neckwear").value = { dangerous: "object" };
  metadata.attributes.find(a => a?.trait_type === "Motif").value = '<img src=x onerror="alert(1)">';
  metadata.attributes.find(a => a?.trait_type === "Palette").value = "A".repeat(1000);
  metadata.attributes.find(a => a?.trait_type === "Appearance").value = "020";
  metadata.attributes.find(a => a?.trait_type === "Stage").value = -1;
  const rows = new Map(getDeltaXTraitRows(metadata));
  for (const label of ["Headwear", "Neckwear", "Motif", "Palette", "Appearance", "Stage"]) {
    assert.equal(rows.get(label), "Unavailable", label);
  }
  assert.equal(rows.has("Untrusted label"), false);
  assert.equal(getDeltaXTraitRows(uniqueMetadata([{ trait_type: "Artwork", value: "deltax-soft-v1" }])), null);
  assert.equal(getDeltaXTraitRows({ attributes: Array(65).fill({ trait_type: "Artwork", value: "deltax-unique-v1" }) }), null);
  for (const invalid of [null, {}, { attributes: "invalid" }, { attributes: [{ trait_type: "Artwork", value: "future-version" }] }]) {
    assert.equal(getDeltaXTraitRows(invalid), null);
  }
});

test("original five-base artwork retains its own metadata rows without unique accessory claims", () => {
  const rows = new Map(getDeltaXTraitRows({ attributes: [
    { trait_type: "Artwork", value: "deltax-soft-v1" },
    { trait_type: "Species", value: "Cat" },
    { trait_type: "Stage", value: "2" },
  ] }));
  assert.equal(rows.get("Species"), "Cat");
  assert.equal(rows.get("Stage"), "2");
  assert.equal(rows.get("Artwork"), "DeltaX Soft & Sweet v1");
  assert.equal(rows.has("Headwear"), false);
  assert.equal(rows.has("Appearance"), false);
});
