import { authorizeClaim } from "./claim-authorization.js";

const TERMINAL = new Set([
  "CONFIRMED", "CLAIM_CONFLICT", "MINED_REVERTED", "NEEDS_RECONCILIATION", "EXPIRED_UNSENT",
]);

export function randomRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function buildSponsoredClaim({
  secret, proof, root, chainId, contractAddress, seriesId, serial, recipient,
  ttlSeconds = 600, now = Date.now(),
}) {
  const deadline = BigInt(Math.floor(now / 1000) + ttlSeconds);
  const { credentialSigner, signature } = await authorizeClaim({
    secret,
    proof,
    root,
    chainId,
    contractAddress,
    seriesId,
    serial,
    recipient,
    deadline,
  });
  return {
    deadline: String(deadline),
    credentialSigner,
    signature,
    body: {
      seriesId: String(seriesId),
      serial,
      credentialSigner,
      proof,
      recipient,
      deadline: String(deadline),
      signature,
    },
  };
}

export async function waitForClaim({
  api, jobId, onUpdate, signal, timeoutMs = 5 * 60 * 1000,
}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) {
      const error = new Error("The claim wait was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    const job = await api.getClaim(jobId, { signal });
    onUpdate?.(job);
    if (TERMINAL.has(job.status)) return job;
    await sleep(Math.max(1000, Number(job.pollAfterMs) || 2500));
  }
  const error = new Error(
    "The claim is still being processed. Open My Pets in a minute; the platform will not submit it twice.",
  );
  error.code = "CLAIM_TIMEOUT";
  throw error;
}

export function describeClaimJob(job) {
  switch (job?.status) {
    case "QUEUED":
      return "Your claim is queued for the platform sponsor.";
    case "SIGNED":
      return "The sponsor signed the claim; it has not been broadcast yet.";
    case "PENDING":
      return "The claim transaction was sent. Waiting for a block.";
    case "BROADCAST_UNKNOWN":
      return "The network did not confirm the broadcast. The same transaction will be retried, never a second one.";
    case "MINED_SUCCESS":
      return "The claim is in a block. Waiting for the required confirmations.";
    case "CONFIRMED":
      return "The pet is confirmed in your Glowpet wallet.";
    case "CLAIM_CONFLICT":
      return "This charm was activated to a different wallet. No second pet was minted.";
    case "MINED_REVERTED":
      return "The claim transaction reverted. No pet was minted.";
    case "EXPIRED_UNSENT":
      return "The claim authorization expired before it was signed. Scan the charm again to re-authorize.";
    case "NEEDS_RECONCILIATION":
      return "The claim needs a manual reconciliation. Do not submit it again; contact support with the claim id.";
    default:
      return "The claim status is unknown. Check My Pets before trying again.";
  }
}
