import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const builder = fileURLToPath(new URL("../scripts/build-serials.mjs", import.meta.url));
const fixtureSeed = `0x${"23".repeat(32)}`;

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glowpet-artwork-credentials-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, extra) {
  return spawnSync(process.execPath, [builder, "--supply", "3", "--seed", fixtureSeed, ...extra], {
    cwd, encoding: "utf8", timeout: 15_000,
  });
}

test("DeltaX deployment guidance preserves v2 credentials and omits the legacy deployment sequence", (t) => {
  const cwd = workspace(t);
  const roots = [];
  for (const artwork of ["legacy-svg", "deltax"]) {
    const out = path.join(cwd, artwork);
    const result = run(cwd, ["--out", out, "--artwork", artwork, "--proofs", "all", "--proof-format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const series = JSON.parse(fs.readFileSync(path.join(out, "series.json"), "utf8"));
    const bundle = JSON.parse(fs.readFileSync(path.join(out, "proofs.json"), "utf8"));
    const guide = fs.readFileSync(path.join(out, "deployment.txt"), "utf8");
    roots.push(series.serialRoot);
    if (artwork === "deltax") {
      assert.equal(series.intendedContract, "DeltaXGlowpet");
      assert.equal(series.artworkVersion, "deltax-unique-v2");
      assert.match(guide, /DeltaXGlowpet\(directoryCID, editionSize, artworkSeed\)/);
      assert.match(guide, /Persistently pin/);
      assert.match(guide, /minted only when claimed/);
      assert.doesNotMatch(guide, /GlowpetFaceArt\(/);
      assert.doesNotMatch(guide, /GlowpetArt\(/);
      assert.doesNotMatch(result.stdout, /Next: deploy GlowpetFaceArt/);
    } else {
      assert.match(guide, /1\. GlowpetFaceArt\(\)/);
      assert.equal(series.intendedContract, undefined);
    }
    for (const item of bundle.items) {
      assert.equal(Object.hasOwn(item, "claimUrl"), false);
      assert.equal(result.stdout.includes(item.secret), false);
      assert.equal(guide.includes(item.secret), false);
    }
    assert.equal(result.stdout.includes(fixtureSeed), false);
    assert.equal(guide.includes(fixtureSeed), false);
  }
  assert.equal(roots[0], roots[1], "Selecting artwork guidance must not change the v2 credential tree");
});

test("default guidance remains compatible with existing legacy SVG deployment workflows", (t) => {
  const cwd = workspace(t);
  const out = path.join(cwd, "default");
  const result = run(cwd, ["--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Next: deploy GlowpetFaceArt -> GlowpetArt -> Glowpet/);
  assert.match(fs.readFileSync(path.join(out, "deployment.txt"), "utf8"), /3\. Glowpet\(artAddress\)/);
});

test("invalid artwork modes and DeltaX capacity overflow fail before creating credentials", (t) => {
  const cwd = workspace(t);
  for (const [name, options, error] of [
    ["unknown", ["--artwork", "unknown"], /--artwork must be legacy-svg or deltax/],
    ["missing", ["--artwork"], /--artwork must be legacy-svg or deltax/],
    ["overflow", ["--artwork", "deltax", "--supply", "18433"], /DeltaX supply must not exceed 18432/],
  ]) {
    const out = path.join(cwd, name);
    const result = run(cwd, ["--out", out, ...options]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(fs.existsSync(out), false);
  }
});
