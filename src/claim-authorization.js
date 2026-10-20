import { AbiCoder, Wallet, concat, isAddress, isHexString, keccak256 } from "ethers";

export const CLAIM_PROTOCOL_VERSION = 2;
export const CLAIM_DOMAIN_NAME = "Glowpet";
export const CLAIM_DOMAIN_VERSION = "2";
export const CLAIM_TYPES = {
  Claim: [
    { name: "seriesId", type: "uint256" },
    { name: "serial", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

const coder = AbiCoder.defaultAbiCoder();

// A charm credential is a one-purpose signing key, never the user's wallet key.
// Only its public address, proof and recipient-bound signature leave the browser.
export async function authorizeClaim({
  secret, proof, root, chainId, contractAddress, seriesId, serial, recipient, deadline,
}) {
  if (!isHexString(secret, 32)) throw new Error("Enter the 32-byte credential from your charm.");
  let credential;
  try {
    credential = new Wallet(secret);
  } catch {
    throw new Error("This charm credential is not a valid signing key.");
  }
  if (!isAddress(recipient) || !isAddress(contractAddress)) {
    throw new Error("The recipient or contract address is invalid.");
  }
  let hash = keccak256(coder.encode(
    ["uint256", "uint256", "uint32", "address"],
    [chainId, seriesId, serial, credential.address],
  ));
  for (const node of proof) {
    if (!isHexString(node, 32)) throw new Error("The claim proof contains an invalid node.");
    hash = keccak256(concat(BigInt(hash) < BigInt(node) ? [hash, node] : [node, hash]));
  }
  if (hash.toLowerCase() !== root.toLowerCase()) {
    throw new Error(
      "This credential does not match this series. Use a v2 claim code; older credentials require a new series and deployment.",
    );
  }
  const signature = await credential.signTypedData(
    { name: CLAIM_DOMAIN_NAME, version: CLAIM_DOMAIN_VERSION, chainId, verifyingContract: contractAddress },
    CLAIM_TYPES,
    { seriesId, serial, recipient, deadline },
  );
  return { credentialSigner: credential.address, signature };
}

export function assertClaimProtocol(version) {
  if (version !== undefined && Number(version) !== CLAIM_PROTOCOL_VERSION) {
    throw new Error("This is an older claim credential. Ask for a v2 claim code for the new deployment.");
  }
}

export function scrubClaimParameters(search) {
  const params = new URLSearchParams(search);
  for (const field of ["secret", "k", "proof", "merkleProof", "p", "serial", "n"]) {
    params.delete(field);
  }
  return params;
}
