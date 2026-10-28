import {
  AbiCoder,
  concat,
  getAddress,
  isAddress,
  isHexString,
  keccak256,
  verifyTypedData,
} from "ethers";

export const CLAIM_PROTOCOL_VERSION = 2;
export const CLAIM_DOMAIN_NAME = "Glowpet";
export const CLAIM_DOMAIN_VERSION = "2";
export const CLAIM_TYPES = Object.freeze({
  Claim: Object.freeze([
    Object.freeze({ name: "seriesId", type: "uint256" }),
    Object.freeze({ name: "serial", type: "uint32" }),
    Object.freeze({ name: "recipient", type: "address" }),
    Object.freeze({ name: "deadline", type: "uint256" }),
  ]),
});

const coder = AbiCoder.defaultAbiCoder();
const UINT32_MAX = 0xffff_ffffn;
const UINT256_MAX = (1n << 256n) - 1n;

function asBigInt(value, label, { positive = false } = {}) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer.`);
  }
  if (parsed < 0n || parsed > UINT256_MAX || (positive && parsed === 0n)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return parsed;
}

export function normalizeBytes32(value, label = "Hash") {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new Error(`${label} must be 32 bytes of hex.`);
  }
  return value.toLowerCase();
}

/**
 * The on-chain leaf. It deliberately commits to the deployment chain and the
 * series so a credential cannot be replayed elsewhere.
 */
export function claimLeaf({ chainId, seriesId, serial, credentialSigner }) {
  const chain = asBigInt(chainId, "Chain id", { positive: true });
  const series = asBigInt(seriesId, "Series id");
  const serialNumber = asBigInt(serial, "Serial", { positive: true });
  if (serialNumber > UINT32_MAX) throw new Error("Serial is outside the uint32 range.");
  if (!isAddress(credentialSigner)) throw new Error("Credential signer is not an address.");
  return keccak256(coder.encode(
    ["uint256", "uint256", "uint32", "address"],
    [chain, series, serialNumber, getAddress(credentialSigner)],
  ));
}

export function claimRootFromProof(proof, leaf) {
  let hash = normalizeBytes32(leaf, "Leaf");
  for (const value of proof) {
    const node = normalizeBytes32(value, "Proof node");
    hash = keccak256(concat(BigInt(hash) < BigInt(node) ? [hash, node] : [node, hash]));
  }
  return hash;
}

export function verifyClaimProof({ proof, root, chainId, seriesId, serial, credentialSigner }) {
  if (!Array.isArray(proof)) throw new Error("Proof must be an array of hashes.");
  const expected = normalizeBytes32(root, "Series root");
  return claimRootFromProof(proof, claimLeaf({ chainId, seriesId, serial, credentialSigner })) === expected;
}

export function claimDomain({ chainId, verifyingContract }) {
  const chain = asBigInt(chainId, "Chain id", { positive: true });
  if (!isAddress(verifyingContract)) throw new Error("Glowpet contract is not an address.");
  return {
    name: CLAIM_DOMAIN_NAME,
    version: CLAIM_DOMAIN_VERSION,
    chainId: chain,
    verifyingContract: getAddress(verifyingContract),
  };
}

export function claimMessage({ seriesId, serial, recipient, deadline }) {
  const series = asBigInt(seriesId, "Series id");
  const serialNumber = asBigInt(serial, "Serial", { positive: true });
  const expires = asBigInt(deadline, "Deadline", { positive: true });
  if (serialNumber > UINT32_MAX) throw new Error("Serial is outside the uint32 range.");
  if (!isAddress(recipient)) throw new Error("Recipient is not an address.");
  return {
    seriesId: series,
    serial: serialNumber,
    recipient: getAddress(recipient),
    deadline: expires,
  };
}

export function buildClaimTypedData({ chainId, verifyingContract, seriesId, serial, recipient, deadline }) {
  return {
    domain: claimDomain({ chainId, verifyingContract }),
    types: CLAIM_TYPES,
    message: claimMessage({ seriesId, serial, recipient, deadline }),
  };
}

export function recoverClaimSigner({ chainId, verifyingContract, seriesId, serial, recipient, deadline, signature }) {
  const typed = buildClaimTypedData({ chainId, verifyingContract, seriesId, serial, recipient, deadline });
  if (typeof signature !== "string" || !isHexString(signature)) {
    throw new Error("Claim signature is not valid hex.");
  }
  return verifyTypedData(typed.domain, typed.types, typed.message, signature);
}

export function verifyClaimAuthorization({
  chainId,
  verifyingContract,
  seriesId,
  serial,
  credentialSigner,
  recipient,
  deadline,
  signature,
}) {
  if (!isAddress(credentialSigner)) throw new Error("Credential signer is not an address.");
  const signer = recoverClaimSigner({
    chainId, verifyingContract, seriesId, serial, recipient, deadline, signature,
  });
  if (signer.toLowerCase() !== credentialSigner.toLowerCase()) {
    throw new Error("The claim authorization does not match this charm and recipient.");
  }
  return signer;
}

export function normalizeAddress(value, label = "Address") {
  if (!isAddress(value)) throw new Error(`${label} is not an address.`);
  return getAddress(value);
}
