import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AbiCoder, Wallet, computeAddress, concat, keccak256, verifyTypedData } from "ethers";
import {
  assertPrivateOutput,
  findPublishedCredentials,
} from "../scripts/credential-safety.mjs";
import { forbidPublishedProofs } from "../vite.config.js";

const builder = fileURLToPath(new URL("../scripts/build-serials.mjs", import.meta.url));
// Synthetic fixtures only. No existing project credentials or deployed roots.
const TEST_SEED = `0x${"11".repeat(32)}`;
const coder = AbiCoder.defaultAbiCoder();

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glowpet-credentials-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runBuilder(cwd, extra = []) {
  return spawnSync(process.execPath, [
    builder, "--supply", "5", "--series", "23", "--chain-id", "31337",
    "--seed", TEST_SEED, ...extra,
  ], { cwd, encoding: "utf8" });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rootFrom(leaf, proof) {
  return proof.reduce(
    (value, sibling) => keccak256(concat(value < sibling ? [value, sibling] : [sibling, value])),
    leaf,
  );
}

test("v2 exports use credential signer leaves, valid proofs and versioned URLs", async (t) => {
  const cwd = workspace(t);
  const output = path.join(cwd, "private-series");
  const result = runBuilder(cwd, ["--out", output, "--proofs", "all", "--split", "all"]);
  assert.equal(result.status, 0, result.stderr);
  const series = readJson(path.join(output, "series.json"));
  const bundle = readJson(path.join(output, "proofs.json"));
  assert.equal(series.protocolVersion, 2);
  assert.equal(series.claimDomainVersion, "2");
  assert.equal(bundle.protocolVersion, 2);
  assert.equal(bundle.items.length, 5);
  assert.equal(Object.hasOwn(series, "secret"), false);

  for (const item of bundle.items) {
    assert.equal(item.protocolVersion, 2);
    assert.equal(item.credentialSigner, computeAddress(item.secret));
    const leaf = keccak256(coder.encode(
      ["uint256", "uint256", "uint32", "address"],
      [31337, 23, item.serial, item.credentialSigner],
    ));
    assert.equal(rootFrom(leaf, item.proof), series.serialRoot);
    const legacyLeaf = keccak256(coder.encode(
      ["uint256", "uint256", "uint32", "bytes32"], [31337, 23, item.serial, item.secret],
    ));
    assert.notEqual(rootFrom(legacyLeaf, item.proof), series.serialRoot);
    const split = readJson(path.join(output, "proofs", `${item.serial}.json`));
    assert.equal(split.protocolVersion, 2);
    assert.equal(split.credentialSigner, item.credentialSigner);
    const url = new URL(split.claimUrl);
    assert.equal(url.searchParams.get("protocolVersion"), "2");
    assert.equal(url.searchParams.get("chainId"), "31337");
    assert.equal(url.searchParams.get("credentialSigner"), item.credentialSigner);
  }

  const credential = bundle.items[0];
  const domain = {
    name: "Glowpet", version: "2", chainId: 31337,
    verifyingContract: "0x0000000000000000000000000000000000001234",
  };
  const types = { Claim: [
    { name: "seriesId", type: "uint256" },
    { name: "serial", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ] };
  const value = {
    seriesId: 23, serial: credential.serial,
    recipient: "0x0000000000000000000000000000000000005678", deadline: 2_000_000_000,
  };
  const signature = await new Wallet(credential.secret).signTypedData(domain, types, value);
  assert.equal(verifyTypedData(domain, types, value, signature), credential.credentialSigner);
  assert.notEqual(
    verifyTypedData(domain, types, { ...value, recipient: domain.verifyingContract }, signature),
    credential.credentialSigner,
  );
  const csv = fs.readFileSync(path.join(output, "proofs.csv"), "utf8");
  assert.match(csv, /^protocolVersion,chainId,seriesId,serial,credentialSigner,secret,proof,tokenId\n/);
  for (const file of ["private/seed.txt", "proofs.json", "proofs.csv", "proofs/1.json"]) {
    assert.equal(fs.statSync(path.join(output, file)).mode & 0o777, 0o600);
  }
});

test("v2 root is reproducible and bound to chain and series", (t) => {
  const cwd = workspace(t);
  const roots = [];
  for (const [name, extra] of [
    ["a", []], ["b", []], ["other-chain", ["--chain-id", "31338"]], ["other-series", ["--series", "24"]],
  ]) {
    const output = path.join(cwd, name);
    const result = runBuilder(cwd, ["--out", output, ...extra]);
    assert.equal(result.status, 0, result.stderr);
    roots.push(readJson(path.join(output, "series.json")).serialRoot);
  }
  assert.equal(roots[0], roots[1]);
  assert.notEqual(roots[0], roots[2]);
  assert.notEqual(roots[0], roots[3]);
});

test("CLI rejects both public root and nested output or split directories before writing", (t) => {
  const cwd = workspace(t);
  for (const target of ["public", "public/generated/deep"]) {
    for (const option of ["--out", "--split-dir"]) {
      const result = runBuilder(cwd, ["--out", "private-series", "--split", "all", option, target]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to write claim credentials inside public/);
      assert.equal(fs.existsSync(path.join(cwd, "private-series")), false);
      assert.equal(fs.existsSync(path.join(cwd, "public")), false);
    }
  }
});

test("CLI rejects linked output ancestors and linked private children pointing into public", (t) => {
  const cwd = workspace(t);
  const publicDir = path.join(cwd, "public");
  fs.mkdirSync(publicDir);
  fs.symlinkSync(publicDir, path.join(cwd, "alias"));
  for (const option of ["--out", "--split-dir"]) {
    const result = runBuilder(cwd, ["--out", "private-series", "--split", "all", option, "alias/new/deep"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to write claim credentials inside public/);
    assert.deepEqual(fs.readdirSync(publicDir), []);
  }
  const output = path.join(cwd, "private-series");
  fs.mkdirSync(output);
  fs.symlinkSync(publicDir, path.join(output, "private"));
  const result = runBuilder(cwd, ["--out", output, "--force"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to write claim credentials inside public/);
  assert.deepEqual(fs.readdirSync(publicDir), []);
  assert.equal(fs.existsSync(path.join(output, "series.json")), false);
});

test("private sibling directories are allowed, dangling output links fail closed", (t) => {
  const cwd = workspace(t);
  assert.doesNotThrow(() => assertPrivateOutput(path.join(cwd, "public-backup", "files"), [path.join(cwd, "public")]));
  fs.symlinkSync(path.join(cwd, "missing"), path.join(cwd, "dangling"));
  assert.throws(
    () => assertPrivateOutput(path.join(cwd, "dangling", "files"), [path.join(cwd, "public")]),
    /Cannot safely resolve output symlink/,
  );
});

test("build guard detects nested JSON objects and arrays without rejecting public series metadata", (t) => {
  const cwd = workspace(t);
  const publicDir = path.join(cwd, "public");
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, "series.json"), JSON.stringify({
    protocolVersion: 2, serialRoot: `0x${"00".repeat(32)}`, leafCount: 5,
  }));
  assert.deepEqual(findPublishedCredentials(publicDir), []);
  const nested = path.join(publicDir, "nested.json");
  fs.writeFileSync(nested, JSON.stringify({ collection: [{ payload: { secret: TEST_SEED } }] }));
  assert.deepEqual(findPublishedCredentials(publicDir), [nested]);
  const plugin = forbidPublishedProofs(cwd);
  assert.throws(() => plugin.buildStart.call({ error(message) { throw new Error(message); } }), /Claim credentials found in public/);
});

test("build guard catches CSV credentials, seed exports and linked directories without looping", (t) => {
  const cwd = workspace(t);
  const publicDir = path.join(cwd, "public");
  const linkedDir = path.join(cwd, "linked");
  fs.mkdirSync(publicDir);
  fs.mkdirSync(linkedDir);
  fs.writeFileSync(path.join(publicDir, "credentials.csv"), '\uFEFF"serial","secret","tokenId"\n1,synthetic,23000001\n');
  fs.writeFileSync(path.join(publicDir, "seed.txt"), "synthetic seed export");
  fs.writeFileSync(path.join(publicDir, "renamed.txt"), `seed: ${TEST_SEED}`);
  fs.writeFileSync(path.join(linkedDir, "bundle.json"), JSON.stringify({ items: [{ private_key: TEST_SEED }] }));
  fs.symlinkSync(linkedDir, path.join(publicDir, "linked"));
  fs.symlinkSync(publicDir, path.join(linkedDir, "cycle"));
  assert.deepEqual(
    findPublishedCredentials(publicDir).map((file) => path.relative(publicDir, file)).sort(),
    ["credentials.csv", "linked/bundle.json", "renamed.txt", "seed.txt"],
  );
});
