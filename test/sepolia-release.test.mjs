import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getCreateAddress } from 'ethers';
import {
  assembleReleasePlan, publishedFileSetHash, validateIpfsEvidence, validatePublicSeries,
} from '../scripts/prepare-sepolia-release.mjs';
import { DEFAULT_ARTWORK_SEED } from '../shared/deltax-traits.js';

// Synthetic data tests the plan boundary only; never an IPFS publication record.
const from = '0x1111111111111111111111111111111111111111';
const cid = `bafy${'a'.repeat(55)}`;
const sha = 'ab'.repeat(32);
const verified = { artworkVersion: 'deltax-unique-v2', editionSize: 10000, seed: DEFAULT_ARTWORK_SEED, imageSize: 1254, verifiedImages: 10000, manifestSha256: sha };
const manifest = {
  editionSize: 10000, seed: DEFAULT_ARTWORK_SEED,
  assets: Array.from({ length: 10000 }, (_, index) => ({ file: `portraits/${index}.png`, sha256: index.toString(16).padStart(64, '0') })),
};
const series = {
  chainId: 11155111, protocolVersion: 2, claimDomainVersion: '2', seriesId: 1,
  maxSupply: 10000, leafCount: 10000, salt: 0, serialRoot: `0x${'42'.repeat(32)}`, label: 'Glowpet DeltaX 10000',
};
const inventoryHash = publishedFileSetHash(manifest, sha);
const evidence = {
  schema: 'glowpet-ipfs-verification-v1', cid, manifestSha256: sha, editionSize: 10000,
  fileSetSha256: inventoryHash, pinned: true,
  gateways: ['https://gateway-one.example/ipfs/', 'https://gateway-two.example/ipfs/'].map(baseUrl => ({
    baseUrl, manifestSha256: sha, fileSetSha256: inventoryHash,
    verifiedFiles: 10001, failedFiles: 0, verifiedAt: '2026-11-03T00:00:00Z',
  })),
};
const abi = ['constructor(string directoryCID,uint32 editionSize_,bytes32 seed_)'];
const compiled = {
  compilerVersion: 'test-fixture-not-a-release',
  artifacts: {
    DeltaXGlowpet: { abi, bytecode: '0x60006000', deployedBytecode: '0x6000' },
    DeltaXPortraits: { deployedBytecode: '0x6000' },
  },
};
const base = { verified, manifest, series, from };
const ready = { ...base, cid, nonce: 47, ipfsEvidence: evidence, compiled };

test('unpublished local edition has no CID, address, calldata or signing transaction', async () => {
  const plan = await assembleReleasePlan(base);
  assert.equal(plan.status, 'ready_for_ipfs');
  assert.equal(plan.transactions, null);
  assert.equal(plan.artwork.directoryCID, null);
  assert.equal(plan.initialMinted, 0);
  assert.equal(plan.series.maxSupply, 10000);
  assert.ok(!('expectedContract' in plan));
  await assert.rejects(assembleReleasePlan({ ...base, nonce: 47 }), /before a real CID/);
  await assert.rejects(assembleReleasePlan({ ...base, ipfsEvidence: evidence }), /before a real CID/);
});

test('rejects wrong-chain, undersized, malformed and secret-bearing public inputs', async () => {
  for (const patch of [
    { chainId: 1 }, { protocolVersion: 1 }, { claimDomainVersion: '1' },
    { intendedContract: 'Glowpet' }, { artworkVersion: 'deltax-unique-v1' },
    { maxSupply: 100 }, { leafCount: 100 }, { seriesId: 0 }, { salt: -1 },
    { serialRoot: `0x${'0'.repeat(64)}` }, { label: '猫'.repeat(22) },
    { privateKey: `0x${'99'.repeat(32)}` }, { nested: { proof: [] } },
  ]) assert.throws(() => validatePublicSeries({ ...series, ...patch }));
  await assert.rejects(assembleReleasePlan({ ...base, verified: { ...verified, verifiedImages: 9999 } }), /fully verified/);
  await assert.rejects(assembleReleasePlan({ ...base, verified: { ...verified, editionSize: 100 } }), /fully verified/);
  await assert.rejects(assembleReleasePlan({ ...base, manifest: { ...manifest, seed: `0x${'0'.repeat(64)}` } }), /match/);
  await assert.rejects(assembleReleasePlan({ ...base, from: `0x${'0'.repeat(40)}` }), /nonzero/);
});

test('a CID alone or partial/mismatched remote checks cannot create deployable calldata', async () => {
  await assert.rejects(assembleReleasePlan({ ...base, cid, nonce: 47, compiled }), /evidence/);
  for (const patch of [
    { cid: `bafy${'b'.repeat(55)}` }, { pinned: false }, { manifestSha256: 'cd'.repeat(32) },
    { fileSetSha256: 'ef'.repeat(32) }, { editionSize: 100 }, { gateways: evidence.gateways.slice(0, 1) },
    { gateways: [evidence.gateways[0], evidence.gateways[0]] },
    { gateways: [evidence.gateways[0], { ...evidence.gateways[1], verifiedFiles: 10000 }] },
    { gateways: [evidence.gateways[0], { ...evidence.gateways[1], failedFiles: 1 }] },
    { gateways: [evidence.gateways[0], { ...evidence.gateways[1], baseUrl: 'http://gateway-two.example/ipfs/' }] },
    { gateways: [evidence.gateways[0], { ...evidence.gateways[1], baseUrl: 'https://gateway-two.example/?token=secret' }] },
  ]) await assert.rejects(assembleReleasePlan({ ...ready, ipfsEvidence: { ...evidence, ...patch } }));
  assert.throws(() => validateIpfsEvidence(evidence, { cid: 'pending', manifestSha256: sha, fileSetSha256: inventoryHash }), /real CID/);
});

test('public inventory digest binds every filename and hash independent of order', () => {
  assert.equal(publishedFileSetHash({ ...manifest, assets: [...manifest.assets].reverse() }, sha), inventoryHash);
  const assets = [...manifest.assets];
  assets[9000] = { ...assets[9000], sha256: 'ff'.repeat(32) };
  assert.notEqual(publishedFileSetHash({ ...manifest, assets }, sha), inventoryHash);
  assets[9999] = assets[0];
  assert.throws(() => publishedFileSetHash({ ...manifest, assets }, sha), /Duplicate/);
});

test('unsigned transactions bind Sepolia, deployer, CID, edition, nonce and exact series root', async () => {
  const plan = await assembleReleasePlan(ready);
  assert.equal(plan.status, 'unsigned_transactions_prepared');
  assert.equal(plan.expectedContract, getCreateAddress({ from, nonce: 47 }));
  const deployment = plan.transactions.deploy;
  assert.equal(deployment.chainId, '0xaa36a7');
  assert.equal(deployment.from, from);
  assert.equal(deployment.value, '0x0');
  assert.equal(deployment.nonce, '0x2f');
  assert.ok(!('to' in deployment));
  const args = new Interface(abi).encodeDeploy([cid, 10000, DEFAULT_ARTWORK_SEED]);
  assert.equal(deployment.data, compiled.artifacts.DeltaXGlowpet.bytecode + args.slice(2));
  const creation = plan.transactions.createSeries;
  assert.equal(creation.to, plan.expectedContract);
  assert.equal(creation.nonce, '0x30');
  const decoder = new Interface(['function createSeries(uint256,uint64,uint32,bytes32,string)']);
  assert.deepEqual([...decoder.decodeFunctionData('createSeries', creation.data)], [1n, 10000n, 0n, series.serialRoot, series.label]);
  for (const nonce of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(assembleReleasePlan({ ...ready, nonce }), /nonce/);
  }
  await assert.rejects(assembleReleasePlan({ ...ready, compiled: undefined }), /compiled/);
  await assert.rejects(assembleReleasePlan({ ...ready, compiled: { ...compiled, artifacts: { ...compiled.artifacts, DeltaXPortraits: { deployedBytecode: `0x${'00'.repeat(24577)}` } } } }), /EIP-170/);
});
