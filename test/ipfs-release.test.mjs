import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CarReader } from "@ipld/car";
import { publishedFileSetHash } from "../scripts/prepare-sepolia-release.mjs";
import {
  hashPublishedRows, readPublishInventory, packPublishDirectory, verifyGateway,
  assembleVerificationReport, gatewayFileUrl,
} from "../scripts/ipfs-release.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glowpet-ipfs-"));
  await fs.mkdir(path.join(dir, "portraits"), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(dir, name), bytes);
  return dir;
}

test("downloaded inventory hash uses the same canonical rows as the release planner", () => {
  const assets = Array.from({ length: 10_000 }, (_, index) => ({
    file: `portraits/${index}.png`,
    sha256: sha256(`portrait-${index}`),
  }));
  const manifestSha256 = sha256("manifest");
  const rows = [["collection.json", manifestSha256], ...assets.map(a => [a.file, a.sha256])];
  assert.equal(hashPublishedRows(rows), publishedFileSetHash({ assets }, manifestSha256));
  // Order of arrival must not matter; the row set is sorted before hashing.
  assert.equal(hashPublishedRows([...rows].reverse()), hashPublishedRows(rows));
});

test("publish inventory refuses missing, unexpected or altered files", async () => {
  const oneAsset = JSON.stringify({ assets: [{ file: "portraits/1.png", sha256: sha256("one") }] });
  const good = await fixture({ "collection.json": oneAsset, "portraits/1.png": "one" });
  // A complete edition is required before anything can be packed for upload.
  await assert.rejects(readPublishInventory(good), /complete 10000-image manifest/);

  const manifest = {
    editionSize: 10_000,
    assets: [{ file: "portraits/1.png", sha256: sha256("one") }],
  };
  const dir = await fixture({ "collection.json": JSON.stringify(manifest), "portraits/1.png": "one" });
  await fs.writeFile(path.join(dir, "portraits/2.png"), "unexpected");
  await assert.rejects(readPublishInventory(dir), /does not match collection\.json/);

  const altered = await fixture({ "collection.json": JSON.stringify(manifest), "portraits/1.png": "two" });
  await assert.rejects(readPublishInventory(altered), /Hash mismatch for portraits\/1\.png/);
});

test("packing is deterministic and the CAR header carries the directory root", async () => {
  const dir = await fixture({ "collection.json": '{"assets":[]}', "portraits/0.png": "zero", "portraits/1.png": "one" });
  const files = ["collection.json", "portraits/0.png", "portraits/1.png"];
  const first = path.join(dir, "first.car");
  const second = path.join(dir, "second.car");
  const a = await packPublishDirectory({ inventory: { dir, files }, carPath: first });
  const b = await packPublishDirectory({ inventory: { dir, files }, carPath: second });
  assert.match(a.rootCid, /^bafy[a-z2-7]{55}$/);
  assert.equal(a.rootCid, b.rootCid, "the same files must produce the same directory CID");
  assert.ok(a.carBytes > 0);
  const reader = await CarReader.fromBytes(await fs.readFile(first));
  const roots = await reader.getRoots();
  assert.equal(roots[0].toString(), a.rootCid);
});

test("gateway verification hashes what was served, not what was promised", async () => {
  const collection = Buffer.from('{"assets":[]}');
  const portrait = Buffer.from("portrait-bytes");
  const manifest = {
    editionSize: 10_000,
    assets: [{ file: "portraits/7.png", sha256: sha256(portrait) }],
  };
  const manifestSha256 = sha256(collection);
  const cid = "bafy" + "a".repeat(55);
  const files = new Map([
    [gatewayFileUrl("https://gw.example", cid, "collection.json"), collection],
    [gatewayFileUrl("https://gw.example", cid, "portraits/7.png"), portrait],
  ]);
  const fetchImpl = async url => {
    const body = files.get(url);
    return body ? { ok: true, arrayBuffer: async () => body } : { ok: false, status: 404 };
  };
  const result = await verifyGateway({
    baseUrl: "https://gw.example", cid, manifest, manifestSha256, fetchImpl, retries: 0,
  });
  assert.equal(result.verifiedFiles, 2);
  assert.equal(result.failedFiles, 0);
  assert.equal(result.fileSetSha256, hashPublishedRows([["collection.json", manifestSha256], ["portraits/7.png", sha256(portrait)]]));

  const tampered = async url => {
    const body = files.get(url);
    return { ok: Boolean(body), status: body ? 200 : 404, arrayBuffer: async () => (url.endsWith("7.png") ? Buffer.from("tampered") : body) };
  };
  const failed = await verifyGateway({
    baseUrl: "https://gw.example", cid, manifest, manifestSha256, fetchImpl: tampered, retries: 0,
  });
  assert.equal(failed.failedFiles, 1);
  assert.equal(failed.fileSetSha256, null);

  await assert.rejects(
    verifyGateway({ baseUrl: "http://gw.example", cid, manifest, manifestSha256, fetchImpl, retries: 0 }),
    /plain HTTPS base URL/,
  );
  await assert.rejects(
    verifyGateway({ baseUrl: "https://user:pass@gw.example", cid, manifest, manifestSha256, fetchImpl, retries: 0 }),
    /plain HTTPS base URL/,
  );
});

test("evidence requires a confirmed pin and two distinct gateways", () => {
  const base = {
    cid: "bafy" + "b".repeat(55), editionSize: 10_000,
    manifestSha256: "a".repeat(64), fileSetSha256: "b".repeat(64),
    gateways: [
      { baseUrl: "https://one.example", manifestSha256: "a".repeat(64), fileSetSha256: "b".repeat(64), verifiedFiles: 10_001, failedFiles: 0, verifiedAt: new Date().toISOString() },
      { baseUrl: "https://two.example", manifestSha256: "a".repeat(64), fileSetSha256: "b".repeat(64), verifiedFiles: 10_001, failedFiles: 0, verifiedAt: new Date().toISOString() },
    ],
  };
  assert.throws(() => assembleVerificationReport({ ...base, pin: null }), /Pin service confirmation/);
  assert.throws(() => assembleVerificationReport({ ...base, pin: { cid: base.cid, confirmed: false } }), /Pin service confirmation/);
  assert.throws(() => assembleVerificationReport({ ...base, gateways: [base.gateways[0]], pin: { cid: base.cid, confirmed: true } }), /two independently operated gateways/);
  const report = assembleVerificationReport({ ...base, pin: { cid: base.cid, confirmed: true, fileId: "f1", confirmedAt: new Date().toISOString() } });
  assert.equal(report.schema, "glowpet-ipfs-verification-v1");
  assert.equal(report.pinned, true);
  assert.equal(report.gateways.length, 2);
});
