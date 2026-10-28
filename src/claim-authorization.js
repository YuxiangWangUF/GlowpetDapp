import { Wallet, isAddress, isHexString } from "ethers";
import {
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_PROTOCOL_VERSION,
  CLAIM_TYPES,
  claimDomain,
  claimMessage,
  claimRootFromProof,
  claimLeaf,
} from "../shared/claim-protocol.js";

export {
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_PROTOCOL_VERSION,
  CLAIM_TYPES,
};

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

  let expectedRoot;
  try {
    expectedRoot = claimRootFromProof(proof, claimLeaf({
      chainId, seriesId, serial, credentialSigner: credential.address,
    }));
  } catch (error) {
    throw new Error(error.message);
  }
  if (expectedRoot.toLowerCase() !== String(root).toLowerCase()) {
    throw new Error(
      "This credential does not match this series. Use a v2 claim code; older credentials require a new series and deployment.",
    );
  }

  const typed = {
    domain: claimDomain({ chainId, verifyingContract: contractAddress }),
    types: CLAIM_TYPES,
    message: claimMessage({ seriesId, serial, recipient, deadline }),
  };
  const signature = await credential.signTypedData(typed.domain, typed.types, typed.message);
  return { credentialSigner: credential.address, signature };
}

export function assertClaimProtocol(version) {
  if (version !== undefined && Number(version) !== CLAIM_PROTOCOL_VERSION) {
    throw new Error("This is an older claim credential. Ask for a v2 claim code for the new deployment.");
  }
}

const PRIVATE_CLAIM_FIELDS = [
  "secret", "k", "proof", "merkleProof", "p", "serial", "n",
  "protocolVersion", "chainId", "series", "seriesId", "s", "credentialSigner",
];

export function scrubClaimParameters(search) {
  const params = new URLSearchParams(search);
  for (const field of PRIVATE_CLAIM_FIELDS) params.delete(field);
  return params;
}
