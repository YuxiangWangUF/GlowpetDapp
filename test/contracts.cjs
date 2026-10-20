const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { ethers } = require("ethers");
const hre = require("hardhat");

const STRIDE = 1_000_000n;
const coder = ethers.AbiCoder.defaultAbiCoder();
const types = {
  Claim: [
    { name: "seriesId", type: "uint256" },
    { name: "serial", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};
const artifact = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8",
));
const hashPair = (a, b) => ethers.keccak256(ethers.concat(a < b ? [a, b] : [b, a]));
const leafFor = (chainId, seriesId, serial, signer) => ethers.keccak256(
  coder.encode(["uint256", "uint256", "uint32", "address"], [chainId, seriesId, serial, signer]),
);

function credentials(chainId, seriesId, count = 4) {
  const entries = Array.from({ length: count }, (_, i) => {
    const wallet = ethers.Wallet.createRandom();
    return { serial: i + 1, wallet, leaf: leafFor(chainId, seriesId, i + 1, wallet.address) };
  });
  const sorted = entries.slice().sort((a, b) => a.leaf.localeCompare(b.leaf));
  const levels = [sorted.map((entry) => entry.leaf)];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1);
    const next = [];
    for (let i = 0; i < previous.length; i += 2) {
      next.push(i + 1 < previous.length ? hashPair(previous[i], previous[i + 1]) : previous[i]);
    }
    levels.push(next);
  }
  for (const entry of entries) {
    let index = sorted.indexOf(entry);
    entry.proof = [];
    for (const level of levels.slice(0, -1)) {
      if ((index ^ 1) < level.length) entry.proof.push(level[index ^ 1]);
      index = Math.floor(index / 2);
    }
  }
  return { root: levels.at(-1)[0], entries };
}

async function rejectsWith(action, contract, errorName) {
  await assert.rejects(async () => {
    const result = await action();
    if (result?.wait) await result.wait();
  }, (error) => {
    const candidates = [error.data, error.info?.error?.data, error.error?.data];
    const data = candidates.map((value) => typeof value === "string" ? value : value?.data)
      .find((value) => typeof value === "string" && value.startsWith("0x"));
    assert.equal(data?.slice(0, 10), contract.interface.getError(errorName).selector, error.shortMessage ?? error.message);
    return true;
  });
}

describe("Glowpet v2: physical credential authorisations", function () {
  let provider, operator, recipient, attacker, relayer;
  let faceArt, art, glow, chainId, series, recipientAddress, attackerAddress;

  async function deploy(name, args = []) {
    const compiled = artifact(name);
    const contract = await new ethers.ContractFactory(compiled.abi, compiled.bytecode, operator).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  async function authorisation(entry, {
    seriesId = 1n, recipient: target = recipientAddress, contract = glow,
    signingChainId = chainId, deadline, signingWallet = entry.wallet, version = "2",
  } = {}) {
    deadline ??= BigInt((await provider.getBlock("latest")).timestamp + 3600);
    const signature = await signingWallet.signTypedData({
      name: "Glowpet", version, chainId: signingChainId, verifyingContract: await contract.getAddress(),
    }, types, { seriesId, serial: entry.serial, recipient: target, deadline });
    return { seriesId, serial: entry.serial, credentialSigner: entry.wallet.address, proof: entry.proof, recipient: target, deadline, signature };
  }
  const argsFor = (auth) => [auth.seriesId, auth.serial, auth.credentialSigner, auth.proof, auth.recipient, auth.deadline, auth.signature];
  async function claim(entry = series.entries[0], options = {}, submitter = relayer) {
    const auth = await authorisation(entry, options);
    await (await glow.connect(submitter).claim(...argsFor(auth))).wait();
    return auth;
  }

  before(async function () {
    // Hardhat mines synchronously; avoid reusing a pre-transaction estimate or
    // read for 250 ms after the underlying chain state has changed.
    provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
    operator = await provider.getSigner(0);
    recipient = await provider.getSigner(1);
    attacker = await provider.getSigner(2);
    relayer = await provider.getSigner(3);
    recipientAddress = await recipient.getAddress();
    attackerAddress = await attacker.getAddress();
    chainId = (await provider.getNetwork()).chainId;
    faceArt = await deploy("GlowpetFaceArt");
    art = await deploy("GlowpetArt", [await faceArt.getAddress()]);
  });

  beforeEach(async function () {
    glow = await deploy("Glowpet", [await art.getAddress()]);
    series = credentials(chainId, 1n);
    await (await glow.createSeries(1n, series.entries.length, 0, series.root, "测试 <Glow & Pet>")).wait();
  });

  it("advertises v2 and accepts a relayer without exposing the private key in calldata", async function () {
    assert.equal(await glow.claimProtocolVersion(), 2n);
    const auth = await claim();
    assert.equal(await glow.ownerOf(1_000_001n), recipientAddress);
    const state = await glow.petState(1_000_001n);
    assert.equal(state.serial, 1n);
    assert.equal(state.seriesId, 1n);
    assert.equal((await glow.seriesInfo(1n)).minted, 1n);
    const encoded = glow.interface.encodeFunctionData("claim", argsFor(auth));
    assert.equal(encoded.includes(series.entries[0].wallet.privateKey.slice(2)), false);
  });

  it("rejects an observer re-signing the disclosed proof with their own key", async function () {
    const entry = series.entries[0];
    const forged = await authorisation(entry, { recipient: attackerAddress, signingWallet: ethers.Wallet.createRandom() });
    await rejectsWith(() => glow.connect(attacker).claim(...argsFor(forged)), glow, "InvalidSignature");
    const attackerCredential = { ...forged, credentialSigner: attackerAddress };
    await rejectsWith(() => glow.connect(attacker).claim(...argsFor(attackerCredential)), glow, "InvalidProof");
    await claim(entry);
    assert.equal(await glow.ownerOf(1_000_001n), recipientAddress);
  });

  it("rejects copying an authorisation while changing the recipient", async function () {
    const auth = await authorisation(series.entries[0]);
    await rejectsWith(() => glow.connect(attacker).claim(...argsFor({ ...auth, recipient: attackerAddress })), glow, "InvalidSignature");
    await (await glow.connect(attacker).claim(...argsFor(auth))).wait();
    assert.equal(await glow.ownerOf(1_000_001n), recipientAddress);
  });

  it("rejects changing the serial, reusing a proof in another series, and v1 signatures", async function () {
    const auth = await authorisation(series.entries[0]);
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, serial: 2 })), glow, "InvalidProof");
    await (await glow.createSeries(2n, 4, 0, series.root, "Second")).wait();
    const secondSeries = await authorisation(series.entries[0], { seriesId: 2n });
    await rejectsWith(() => glow.claim(...argsFor(secondSeries)), glow, "InvalidProof");
    const legacy = await authorisation(series.entries[0], { version: "1" });
    await rejectsWith(() => glow.claim(...argsFor(legacy)), glow, "InvalidSignature");
  });

  it("binds the Merkle proof and signature to the chain", async function () {
    const auth = await authorisation(series.entries[0], { signingChainId: chainId + 1n });
    await rejectsWith(() => glow.claim(...argsFor(auth)), glow, "InvalidSignature");
    const foreign = credentials(chainId + 1n, 2n);
    await (await glow.createSeries(2n, 4, 0, foreign.root, "Foreign")).wait();
    const foreignAuth = await authorisation(foreign.entries[0], { seriesId: 2n });
    await rejectsWith(() => glow.claim(...argsFor(foreignAuth)), glow, "InvalidProof");
  });

  it("binds an authorisation to its contract address", async function () {
    const other = await deploy("Glowpet", [await art.getAddress()]);
    await (await other.createSeries(1n, 4, 0, series.root, "Other deployment")).wait();
    const auth = await authorisation(series.entries[0]);
    await rejectsWith(() => other.claim(...argsFor(auth)), other, "InvalidSignature");
    const otherAuth = await authorisation(series.entries[0], { contract: other });
    await (await other.claim(...argsFor(otherAuth))).wait();
    assert.equal(await other.ownerOf(1_000_001n), recipientAddress);
  });

  it("rejects expired or malformed signatures and zero addresses", async function () {
    const expired = await authorisation(series.entries[0], { deadline: 1n });
    await rejectsWith(() => glow.claim(...argsFor(expired)), glow, "SignatureExpired");
    const auth = await authorisation(series.entries[0]);
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, signature: "0x1234" })), glow, "InvalidSignature");
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, credentialSigner: ethers.ZeroAddress })), glow, "InvalidCredentialSigner");
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, recipient: ethers.ZeroAddress })), glow, "InvalidRecipient");
  });

  it("allows one claim per serial and enforces supply and serial bounds", async function () {
    const auth = await claim();
    await rejectsWith(() => glow.claim(...argsFor(auth)), glow, "AlreadyClaimed");
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, serial: 0 })), glow, "InvalidSerial");
    await rejectsWith(() => glow.claim(...argsFor({ ...auth, serial: 5 })), glow, "InvalidSerial");
    for (const entry of series.entries.slice(1)) await claim(entry);
    assert.equal((await glow.seriesInfo(1n)).minted, 4n);
    await rejectsWith(() => glow.claim(...argsFor(auth)), glow, "MaxSupplyReached");
  });

  it("permanently closes a series and enforces operator-only administration", async function () {
    await rejectsWith(() => glow.connect(attacker).closeSeries(1n), glow, "OwnableUnauthorizedAccount");
    await (await glow.closeSeries(1n)).wait();
    const auth = await authorisation(series.entries[0]);
    await rejectsWith(() => glow.claim(...argsFor(auth)), glow, "SeriesNotOpen");
    await rejectsWith(() => glow.closeSeries(1n), glow, "SeriesNotOpen");
    await rejectsWith(() => glow.createSeries(1n, 4, 0, series.root, "Reopened"), glow, "SeriesExists");
    await rejectsWith(() => glow.connect(attacker).createSeries(2n, 4, 0, series.root, "Other"), glow, "OwnableUnauthorizedAccount");
  });

  it("transfers ownership while retaining the token's identity and traits", async function () {
    await claim();
    const before = await glow.petState(1_000_001n);
    await (await glow.connect(recipient).transferFrom(recipientAddress, attackerAddress, 1_000_001n)).wait();
    assert.equal(await glow.ownerOf(1_000_001n), attackerAddress);
    assert.deepEqual(await glow.petState(1_000_001n), before);
    await rejectsWith(() => glow.connect(recipient).transferFrom(attackerAddress, recipientAddress, 1_000_001n), glow, "ERC721InsufficientApproval");
  });

  it("evolves monotonically through stage 255 with a readable level 256", async function () {
    await claim();
    const original = await glow.tokenURI(1_000_001n);
    await rejectsWith(() => glow.connect(recipient).evolve(1_000_001n, 1), glow, "OwnableUnauthorizedAccount");
    await (await glow.evolve(1_000_001n, 1)).wait();
    assert.notEqual(await glow.tokenURI(1_000_001n), original);
    await rejectsWith(() => glow.evolve(1_000_001n, 1), glow, "StageMustIncrease");
    await (await glow.evolve(1_000_001n, 255)).wait();
    const state = await glow.petState(1_000_001n);
    assert.equal(state.stage, 255n);
    assert.equal(state.level, 256n);
    assert.match(await glow.tokenURI(1_000_001n), /^data:application\/json;base64,/);
    await rejectsWith(() => glow.evolve(1_000_001n, 254), glow, "StageMustIncrease");
  });

  it("rejects invalid configuration and overflowing series ids before accepting a root", async function () {
    await rejectsWith(() => glow.createSeries(0n, 1, 0, series.root, "Invalid"), glow, "InvalidConfig");
    await rejectsWith(() => glow.createSeries(2n, 0, 0, series.root, "Invalid"), glow, "InvalidConfig");
    await rejectsWith(() => glow.createSeries(2n, 1_000_000, 0, series.root, "Invalid"), glow, "InvalidConfig");
    await rejectsWith(() => glow.createSeries(2n, 1, 0, ethers.ZeroHash, "Invalid"), glow, "InvalidConfig");
    await rejectsWith(() => glow.createSeries(2n, 1, 0, series.root, "宠".repeat(22)), glow, "InvalidConfig");
    const maxSeriesId = (ethers.MaxUint256 - 1n) / STRIDE;
    await rejectsWith(() => glow.createSeries(maxSeriesId + 1n, 1, 0, series.root, "Overflow"), glow, "InvalidConfig");
    const boundary = credentials(chainId, maxSeriesId, 1);
    await (await glow.createSeries(maxSeriesId, 1, 0, boundary.root, "Boundary")).wait();
    await claim(boundary.entries[0], { seriesId: maxSeriesId });
    assert.equal(await glow.ownerOf(maxSeriesId * STRIDE + 1n), recipientAddress);
  });

  it("renders parseable on-chain metadata and escapes the series label", async function () {
    await claim();
    const uri = await glow.tokenURI(1_000_001n);
    const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    assert.equal(metadata.name, "Glowpet #1000001");
    const svg = Buffer.from(metadata.image.split(",")[1], "base64").toString("utf8");
    assert.match(svg, /<svg /);
    assert.match(svg, /测试 &lt;Glow &amp; Pet&gt;/);
    assert.match(svg, /id="gp-head"/);
  });

  it("renders every supported species and retains deterministic traits after evolution", async function () {
    const all = credentials(chainId, 4n, 200);
    await (await glow.createSeries(4n, 200, 0, all.root, "All species")).wait();
    const representatives = new Map();
    for (const entry of all.entries) {
      const tokenId = 4n * STRIDE + BigInt(entry.serial);
      const hash = BigInt(ethers.keccak256(coder.encode(["uint256"], [tokenId])));
      const species = Number((hash >> 128n) & 255n) % 14;
      if (!representatives.has(species)) representatives.set(species, { ...entry, tokenId });
    }
    assert.equal(representatives.size, 14);
    const portraits = new Set();
    for (const [species, entry] of representatives) {
      await claim(entry, { seriesId: 4n });
      const state = await glow.petState(entry.tokenId);
      assert.equal(state.species, BigInt(species));
      const uri = await glow.tokenURI(entry.tokenId);
      const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
      assert.match(Buffer.from(metadata.image.split(",")[1], "base64").toString("utf8"), /<\/svg>$/);
      portraits.add(metadata.image);
      await (await glow.evolve(entry.tokenId, 1)).wait();
      const evolved = await glow.petState(entry.tokenId);
      for (const field of ["species", "palette", "eyeStyle", "mouthStyle", "accessory", "eyewear", "frameColor", "bodyShape", "tilt"]) {
        assert.equal(evolved[field], state[field]);
      }
    }
    assert.equal(portraits.size, 14);
  });

  it("deploys all three contracts below the EIP-170 size limit", async function () {
    for (const [name, contract] of [["GlowpetFaceArt", faceArt], ["GlowpetArt", art], ["Glowpet", glow]]) {
      const deployed = await provider.getCode(await contract.getAddress());
      assert.ok((deployed.length - 2) / 2 <= 24_576, `${name} exceeds the runtime limit`);
    }
  });

  it("claims every credential exported by the actual v2 series builder", async function () {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "glowpet-contract-test-"));
    try {
      const output = path.join(temp, "series");
      execFileSync(process.execPath, [
        "scripts/build-serials.mjs", "--chain-id", String(chainId), "--series", "3", "--supply", "5",
        "--split", "all", "--out", output,
      ], { cwd: path.join(__dirname, ".."), stdio: "pipe" });
      const info = JSON.parse(fs.readFileSync(path.join(output, "series.json"), "utf8"));
      await (await glow.createSeries(3n, 5, 0, info.serialRoot, "Builder")).wait();
      for (let serial = 1; serial <= 5; serial++) {
        const item = JSON.parse(fs.readFileSync(path.join(output, "proofs", `${serial}.json`), "utf8"));
        const wallet = new ethers.Wallet(item.secret);
        assert.equal(item.credentialSigner, wallet.address);
        await claim({ serial, wallet, proof: item.proof }, { seriesId: 3n });
        assert.equal(await glow.ownerOf(3n * STRIDE + BigInt(serial)), recipientAddress);
      }
      assert.equal((await glow.seriesInfo(3n)).minted, 5n);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
