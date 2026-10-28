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
  path.join(__dirname, "..", "artifacts", "contracts", `${name === "DeltaXPortraits" ? "DeltaXGlowpet" : name}.sol`, `${name}.json`), "utf8",
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

  it("rejects zero and externally owned addresses for immutable renderers", async function () {
    for (const address of [ethers.ZeroAddress, recipientAddress]) {
      await rejectsWith(() => deploy("Glowpet", [address]), glow, "InvalidConfig");
      await rejectsWith(() => deploy("GlowpetArt", [address]), art, "InvalidConfig");
    }
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
    // Compare the returned values; ethers Result wraps them in a Proxy whose
    // internal state is not a portable deepStrictEqual target across Node versions.
    assert.deepEqual(Array.from(await glow.petState(1_000_001n)), Array.from(before));
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

  const fixtureCID = "bafy" + "a".repeat(55); // Syntax fixture, not an uploaded collection.
  const decodeMetadata = (uri) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
  const appearanceObject = (tuple) => Object.fromEntries(
    ["appearanceId", "speciesIndex", "headwear", "neckwear", "palette", "motif"].map((key) => [key, Number(tuple[key])]),
  );

  it("claims all five unique DeltaX species with truthful stable metadata through transfer and evolution", async function () {
    const rules = await import("../shared/deltax-traits.js");
    const seed = ethers.ZeroHash; // First allocations cover all five species.
    glow = await deploy("DeltaXGlowpet", [fixtureCID, 10, seed]);
    assert.equal(await glow.artworkVersion(), rules.ARTWORK_VERSION);
    assert.equal(await glow.claimProtocolVersion(), 2n);
    assert.equal(await glow.editionSize(), 10n);
    assert.equal(await glow.artworkSeed(), seed);
    const all = credentials(chainId, 5n, 10);
    await (await glow.createSeries(5n, 10, 0, all.root, "DeltaX")).wait();
    const species = new Set(), images = new Set();
    // Mint out of serial order and to one wallet: neither can affect the assignment.
    for (const entry of all.entries.slice(0, 5).reverse()) {
      const tokenId = 5n * STRIDE + BigInt(entry.serial);
      const expected = rules.appearanceTraits(entry.serial - 1, seed);
      await claim(entry, { seriesId: 5n });
      const original = decodeMetadata(await glow.tokenURI(tokenId));
      assert.equal(original.image, `ipfs://${fixtureCID}/portraits/${expected.appearanceId}.png`);
      assert.equal(await glow.appearanceOf(tokenId), BigInt(expected.appearanceId));
      assert.deepEqual(appearanceObject(await glow.appearanceTraits(tokenId)), expected);
      for (const attribute of rules.artworkAttributes(expected)) {
        assert.deepEqual(original.attributes.find((a) => a.trait_type === attribute.trait_type), attribute);
      }
      assert.equal(original.attributes.find((a) => a.trait_type === "Stage").value, "0");
      const state = await glow.petState(tokenId);
      assert.equal(state.species, BigInt(rules.SPECIES[expected.speciesIndex].code));
      species.add(Number(state.species)); images.add(original.image);
      await (await glow.connect(recipient).transferFrom(recipientAddress, attackerAddress, tokenId)).wait();
      await (await glow.evolve(tokenId, 2)).wait();
      const evolved = decodeMetadata(await glow.tokenURI(tokenId));
      assert.equal(evolved.image, original.image);
      assert.deepEqual(appearanceObject(await glow.appearanceTraits(tokenId)), expected);
      assert.deepEqual(evolved.attributes.filter((a) => a.trait_type !== "Stage"), original.attributes.filter((a) => a.trait_type !== "Stage"));
      assert.equal(evolved.attributes.find((a) => a.trait_type === "Stage").value, "2");
      assert.equal(await glow.ownerOf(tokenId), attackerAddress);
    }
    assert.equal(species.size, 5); assert.equal(images.size, 5);
    for (const method of ["tokenURI", "appearanceOf", "appearanceTraits", "petState"]) {
      await assert.rejects(() => glow[method](5_000_011n));
    }
    for (const address of [await glow.getAddress(), await glow.art()]) {
      assert.ok(((await provider.getCode(address)).length - 2) / 2 <= 24_576);
    }
  });

  it("reserves disjoint DeltaX series artwork and never recycles closed or failed reservations", async function () {
    glow = await deploy("DeltaXGlowpet", [fixtureCID, 10, ethers.ZeroHash]);
    const first = credentials(chainId, 11n, 5);
    const second = credentials(chainId, 12n, 5);
    await rejectsWith(() => glow.createSeries(11n, 5, 0, ethers.ZeroHash, "Invalid"), glow, "InvalidConfig");
    await rejectsWith(() => glow.createSeries(11n, 5, 0, first.root, "宠".repeat(22)), glow, "InvalidConfig");
    await rejectsWith(() => glow.connect(attacker).createSeries(11n, 5, 0, first.root, "Denied"), glow, "OwnableUnauthorizedAccount");
    assert.equal(await glow.allocatedArtwork(), 0n);
    await (await glow.createSeries(11n, 5, 0, first.root, "First")).wait();
    assert.equal(await glow.seriesArtworkOffset(11n), 0n);
    await rejectsWith(() => glow.createSeries(11n, 1, 0, first.root, "Duplicate"), glow, "SeriesExists");
    await rejectsWith(() => glow.createSeries(12n, 6, 0, second.root, "Too many"), glow, "ArtworkSupplyExhausted");
    assert.equal(await glow.allocatedArtwork(), 5n);
    assert.equal((await glow.seriesInfo(12n)).maxSupply, 0n);
    await (await glow.createSeries(12n, 5, 0, second.root, "Second")).wait();
    assert.equal(await glow.seriesArtworkOffset(12n), 5n);
    assert.equal(await glow.allocatedArtwork(), 10n);
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      // Interleave two series, with the second series minted in reverse order.
      for (const [seriesId, entry] of [[12n, second.entries[4 - i]], [11n, first.entries[i]]]) {
        await claim(entry, { seriesId });
        ids.add((await glow.appearanceOf(seriesId * STRIDE + BigInt(entry.serial))).toString());
      }
    }
    assert.equal(ids.size, 10);
    await (await glow.closeSeries(11n)).wait();
    await (await glow.closeSeries(12n)).wait();
    assert.equal(await glow.allocatedArtwork(), 10n);
    await rejectsWith(() => glow.createSeries(13n, 1, 0, first.root, "Cannot recycle"), glow, "ArtworkSupplyExhausted");
    assert.equal(await glow.allocatedArtwork(), 10n);
  });

  it("keeps the final reserved artwork valid for the largest legal series id", async function () {
    const rules = await import("../shared/deltax-traits.js");
    glow = await deploy("DeltaXGlowpet", [fixtureCID, rules.APPEARANCE_CAPACITY, rules.DEFAULT_ARTWORK_SEED]);
    const largestSeries = (ethers.MaxUint256 - 1n) / STRIDE;
    await rejectsWith(() => glow.createSeries(largestSeries + 1n, 1, 0, series.root, "Overflow"), glow, "InvalidConfig");
    assert.equal(await glow.allocatedArtwork(), 0n);
    await (await glow.createSeries(1n, rules.APPEARANCE_CAPACITY - 1, 0, series.root, "Reserved")).wait();
    await (await glow.closeSeries(1n)).wait();
    const boundary = credentials(chainId, largestSeries, 1);
    await (await glow.createSeries(largestSeries, 1, 0, boundary.root, "Boundary")).wait();
    assert.equal(await glow.seriesArtworkOffset(largestSeries), BigInt(rules.APPEARANCE_CAPACITY - 1));
    assert.equal(await glow.allocatedArtwork(), BigInt(rules.APPEARANCE_CAPACITY));
    await claim(boundary.entries[0], { seriesId: largestSeries });
    const tokenId = largestSeries * STRIDE + 1n;
    const expected = rules.appearanceTraits(rules.APPEARANCE_CAPACITY - 1, rules.DEFAULT_ARTWORK_SEED);
    assert.equal(await glow.ownerOf(tokenId), recipientAddress);
    assert.equal(await glow.appearanceOf(tokenId), BigInt(expected.appearanceId));
    assert.deepEqual(appearanceObject(await glow.appearanceTraits(tokenId)), expected);
    assert.equal(decodeMetadata(await glow.tokenURI(tokenId)).image, `ipfs://${fixtureCID}/portraits/${expected.appearanceId}.png`);
    await rejectsWith(() => glow.createSeries(2n, 1, 0, series.root, "Full"), glow, "ArtworkSupplyExhausted");
  });

  it("matches the exporter's permutation and trait decoding across seeds and radix boundaries", async function () {
    const rules = await import("../shared/deltax-traits.js");
    const indexes = [...new Set([0, 1, 4, 5, 6, 34, 35, 36, 39, 40, 319, 320, 2559, 2560, rules.APPEARANCE_CAPACITY - 2, rules.APPEARANCE_CAPACITY - 1,
      ...Array.from({ length: 40 }, (_, n) => (n * 7919) % rules.APPEARANCE_CAPACITY)])];
    for (const seed of [ethers.ZeroHash, ethers.MaxUint256.toString(16).padStart(64, "0").replace(/^/, "0x"),
      rules.DEFAULT_ARTWORK_SEED, ethers.toBeHex(3n << 128n, 32), ethers.toBeHex(18429n << 128n, 32)]) {
      const renderer = await deploy("DeltaXPortraits", [fixtureCID, rules.APPEARANCE_CAPACITY, seed]);
      const parameters = rules.permutationParameters(seed);
      assert.equal(await renderer.multiplier(), BigInt(parameters.multiplier));
      assert.equal(await renderer.permutationOffset(), BigInt(parameters.offset));
      assert.equal(parameters.multiplier % 2, 1);
      assert.notEqual(parameters.multiplier % 3, 0);
      for (const index of indexes) {
        const expected = rules.appearanceTraits(index, seed);
        if (expected.headwear === 7) assert.equal(expected.speciesIndex, 1);
        assert.equal(await renderer.appearanceId(index), BigInt(expected.appearanceId));
        assert.deepEqual(appearanceObject(await renderer.appearanceTraits(index)), expected);
      }
      await rejectsWith(() => renderer.appearanceId(rules.APPEARANCE_CAPACITY), renderer, "InvalidArtworkIndex");
      await rejectsWith(() => renderer.appearanceId(ethers.MaxUint256), renderer, "InvalidArtworkIndex");
    }
  });

  it("rejects invalid DeltaX editions and restricts partial editions to exported indexes", async function () {
    const renderer = await deploy("DeltaXPortraits", [fixtureCID, 1, ethers.ZeroHash]);
    assert.equal(await renderer.appearanceId(0), 0n);
    assert.equal(await renderer.imageURI(0), `ipfs://${fixtureCID}/portraits/0.png`);
    await rejectsWith(() => renderer.appearanceId(1), renderer, "InvalidArtworkIndex");
    for (const size of [0, 18_433]) {
      await rejectsWith(() => deploy("DeltaXGlowpet", [fixtureCID, size, ethers.ZeroHash]), renderer, "InvalidEditionSize");
    }
    for (const invalid of ["", "https://example.com", "bafy" + "a".repeat(54) + '"', `ipfs://${fixtureCID}`]) {
      await rejectsWith(() => deploy("DeltaXGlowpet", [invalid, 1, ethers.ZeroHash]), renderer, "InvalidDirectoryCID");
    }
  });
});
