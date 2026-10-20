import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface, Wallet, keccak256, verifyTypedData } from "ethers";
import { authorizeClaim, CLAIM_TYPES, scrubClaimParameters } from "../src/claim-authorization.js";
import { GLOWPET_ABI, parseClaimCode } from "../src/contract.js";

const credential = Wallet.createRandom();
const recipient = Wallet.createRandom().address;
const contractAddress = Wallet.createRandom().address;
const coder = AbiCoder.defaultAbiCoder();
const request = {
  secret: credential.privateKey,
  proof: [],
  root: keccak256(coder.encode(
    ["uint256", "uint256", "uint32", "address"],
    [11155111, 1, 7, credential.address],
  )),
  chainId: 11155111,
  contractAddress,
  seriesId: 1n,
  serial: 7,
  recipient,
  deadline: 2000000000n,
};

test("browser authorization matches v2 contract domain and keeps the key out of calldata", async () => {
  const result = await authorizeClaim(request);
  const domain = { name: "Glowpet", version: "2", chainId: request.chainId, verifyingContract: contractAddress };
  const value = { seriesId: 1n, serial: 7, recipient, deadline: request.deadline };
  assert.equal(verifyTypedData(domain, CLAIM_TYPES, value, result.signature), credential.address);
  assert.notEqual(
    verifyTypedData(domain, CLAIM_TYPES, { ...value, recipient: Wallet.createRandom().address }, result.signature),
    credential.address,
  );
  const data = new Interface(GLOWPET_ABI).encodeFunctionData("claim", [
    1n, 7, result.credentialSigner, [], recipient, request.deadline, result.signature,
  ]);
  assert.ok(!data.includes(credential.privateKey.slice(2)));
  assert.deepEqual(Object.keys(result).sort(), ["credentialSigner", "signature"]);
});

test("legacy secret leaves, a different chain and wrong secrets are rejected before submission", async () => {
  const legacyRoot = keccak256(coder.encode(
    ["uint256", "uint256", "uint32", "bytes32"],
    [request.chainId, 1, 7, credential.privateKey],
  ));
  for (const change of [
    { root: legacyRoot }, { chainId: 1 }, { secret: Wallet.createRandom().privateKey },
  ]) {
    await assert.rejects(authorizeClaim({ ...request, ...change }), /does not match this series/);
  }
  await assert.rejects(authorizeClaim({ ...request, secret: `0x${"0".repeat(64)}` }), /not a valid signing key/);
});

test("credential URL aliases are removed while public navigation is preserved", () => {
  const params = scrubClaimParameters("?k=credential&p=proof&n=7&secret=credential&merkleProof=proof&proof=x&serial=7&token=1000007&view=pendant");
  assert.equal(params.toString(), "token=1000007&view=pendant");
});

test("v1 payloads are rejected and single-token v2 credentials preserve empty proofs", () => {
  assert.throws(() => parseClaimCode(JSON.stringify({ protocolVersion: 1, serial: 7 })), /older claim/);
  assert.throws(() => parseClaimCode("?protocolVersion=1&serial=7"), /older claim/);
  const parsed = parseClaimCode(JSON.stringify({
    protocolVersion: 2, serial: 7, secret: credential.privateKey, proof: [],
  }));
  assert.deepEqual(parsed.proof, []);
  assert.equal(parsed.serial, 7);
});
