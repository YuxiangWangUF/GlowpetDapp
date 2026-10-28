import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// No credentials or network access: create an auditable upload manifest.
const directory = "public/pets/deltax-soft-v1";
const models = ["rabbit", "cat", "fox", "mouse", "sheep"];
const assets = models.map((model) => {
  const file = `${model}.png`;
  const bytes = fs.readFileSync(path.join(directory, file));
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`Invalid PNG: ${file}`);
  return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
  artworkVersion: "deltax-soft-v1",
  status: "prepared_not_uploaded_or_deployed",
  sourceDirectory: directory,
  storage: "IPFS directory, CIDv1 dag-pb sha256; preserve filenames",
  speciesCodes: { rabbit: 2, cat: 0, fox: 4, mouse: 9, sheep: 7 },
  assets,
};
fs.mkdirSync("output/deltax-nft", { recursive: true });
fs.writeFileSync("output/deltax-nft/asset-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("Verified five PNGs; wrote output/deltax-nft/asset-manifest.json. No upload or deployment performed.");
