import { isHexString } from "ethers";
import { nftImageSvg } from "./nft-image.js";
import { assertClaimProtocol } from "./claim-authorization.js";
export { GLOWPET_ABI } from "../shared/glowpet-abi.js";
export { CLAIM_DOMAIN_NAME, CLAIM_DOMAIN_VERSION, CLAIM_TYPES } from "./claim-authorization.js";

/**
 * Public configuration and the small ABI the browser needs.
 *
 * Everything exported from here is bundled into the frontend. VITE_* values
 * are public by definition: never put a private key, seed or API secret in
 * them. The per-charm claim secret is a *user* credential and is only read
 * from the QR link or the manual form.
 */

const env = import.meta.env ?? {};

export const GLOWPET_ADDRESS = String(env.VITE_GLOWPET_ADDRESS ?? "").trim();
export const SERIES_ID = toBigInt(env.VITE_GLOWPET_SERIES_ID, 1n);
export const DEPLOY_BLOCK = Number(env.VITE_DEPLOY_BLOCK ?? 0) || 0;

// An explicitly empty value disables the demo proof-file lookup.
const proofBaseEnv = env.VITE_PROOF_BASE_URL;
export const PROOF_BASE_URL =
  proofBaseEnv === undefined ? "/proofs" : String(proofBaseEnv).replace(/\/+$/, "");

export const SEPOLIA_RPC_URL =
  String(env.VITE_SEPOLIA_RPC_URL ?? "").trim() || "https://ethereum-sepolia-rpc.publicnode.com";
export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";
export const SEPOLIA_EXPLORER_URL = "https://sepolia.etherscan.io";
export const SERIES_STRIDE = 1_000_000n;

// Display names. Index = value stored in the trait struct.
export const SPECIES_NAMES = [
  "Cat", "Dog", "Rabbit", "Bear", "Fox", "Panda", "Frog",
  "Sheep", "Pig", "Mouse", "Penguin", "Cow", "Tiger", "Lion",
];
export const PALETTE_NAMES = [
  "Rose", "Coral", "Peach", "Cream", "Mint",
  "Sage", "Sky", "Periwinkle", "Lavender", "Orchid",
];
export const EYE_NAMES = ["Bright", "Twinkle", "Happy", "Starry", "Sleepy", "Gem"];
export const MOUTH_NAMES = ["Cat", "Smile", "Open"];
export const ACCESSORY_NAMES = ["None", "Bow", "Star", "Sprout", "Crown", "Headphones"];
export const EYEWEAR_NAMES = ["None", "Round", "Square", "Shades", "Cat-eye", "Monocle"];
export const FRAME_NAMES = ["Ink", "Gold", "Silver", "Walnut", "Rose", "Slate"];
export const STAGE_NAMES = ["Newborn", "Growing", "Evolved", "Radiant"];

export function stageName(stage) {
  return STAGE_NAMES[stage] ?? `Stage ${stage}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function sameAddress(a, b) {
  return Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
}

export function padSerial(serial, width = 6) {
  return String(serial).padStart(width, "0");
}

export const txUrl = (hash) => `${SEPOLIA_EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address) => `${SEPOLIA_EXPLORER_URL}/address/${address}`;
export const tokenUrl = (address, tokenId) =>
  `${SEPOLIA_EXPLORER_URL}/token/${address}?a=${tokenId}`;

// ---------------------------------------------------------------------------
// Decoding on-chain data
// ---------------------------------------------------------------------------

export function decodeTokenURI(uri) {
  const jsonPrefix = "data:application/json;base64,";
  if (typeof uri !== "string" || !uri.startsWith(jsonPrefix)) {
    throw new Error("The contract returned an unexpected token URI format.");
  }

  const metadata = JSON.parse(base64ToUtf8(uri.slice(jsonPrefix.length)));
  const imagePrefix = "data:image/svg+xml;base64,";
  const svg =
    typeof metadata.image === "string" && metadata.image.startsWith(imagePrefix)
      ? base64ToUtf8(metadata.image.slice(imagePrefix.length))
      : nftImageSvg(metadata.image);

  return { metadata, image: metadata.image ?? "", svg };
}

function base64ToUtf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function normalizeSeriesInfo(info) {
  return {
    maxSupply: Number(info.maxSupply ?? info[0]),
    minted: Number(info.minted ?? info[1]),
    open: Boolean(info.open ?? info[2]),
    salt: Number(info.salt ?? info[3]),
    root: info.serialRoot ?? info[4],
    label: info.label ?? info[5],
  };
}

export function normalizePetState(state) {
  return {
    species: Number(state.species),
    palette: Number(state.palette),
    eyeStyle: Number(state.eyeStyle),
    mouthStyle: Number(state.mouthStyle),
    accessory: Number(state.accessory),
    eyewear: Number(state.eyewear),
    frameColor: Number(state.frameColor),
    stage: Number(state.stage),
    bodyShape: Number(state.bodyShape),
    tilt: Number(state.tilt),
    level: Number(state.level),
    serial: Number(state.serial),
    seriesId: BigInt(state.seriesId),
  };
}

// ---------------------------------------------------------------------------
// Claim credential parsing
// ---------------------------------------------------------------------------

/**
 * Accepts every shape a charm's QR code might carry:
 *   glowpet://claim?series=1&serial=7&secret=0x…&proof=0x…,0x…
 *   https://…/?serial=7&secret=0x…&proof=0x…
 *   serial=7&secret=0x…&proof=0x…
 *   {"serial":7,"secret":"0x…","proof":["0x…"]}
 */
export function parseClaimCode(input) {
  const text = String(input ?? "").trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    const value = JSON.parse(text);
    assertClaimProtocol(value.protocolVersion);
    return {
      seriesId: toBigInt(value.seriesId ?? value.series, undefined),
      serial: toInteger(value.serial, undefined),
      secret: normalizeSecret(value.secret),
      proof: parseProof(value.proof ?? value.merkleProof),
      source: "JSON payload",
    };
  }

  let params;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    params = new URL(text).searchParams;
  } else if (text.startsWith("?")) {
    params = new URLSearchParams(text.slice(1));
  } else if (text.includes("=")) {
    params = new URLSearchParams(text);
  } else {
    throw new Error("That does not look like a claim link or JSON payload.");
  }

  const serial = toInteger(params.get("serial") ?? params.get("n"), undefined);
  const secret = normalizeSecret(params.get("secret") ?? params.get("k"));
  const proofText = params.get("proof") ?? params.get("merkleProof") ?? params.get("p");
  const proof = proofText ? parseProof(proofText) : [];

  // A URL with only `?token=…` (or unrelated query params) is not a claim code.
  if (serial === undefined && secret === undefined && proof.length === 0) return {};
  assertClaimProtocol(params.get("protocolVersion") ?? undefined);

  return {
    seriesId: toBigInt(params.get("series") ?? params.get("seriesId") ?? params.get("s"), undefined),
    serial,
    secret,
    proof,
    source: "claim link",
  };
}

/**
 * Parses proof nodes from an array, a JSON array, a comma/space/newline
 * separated list, or one long concatenated hex string.
 */
export function parseProof(input) {
  if (input === undefined || input === null || input === "") return [];
  if (Array.isArray(input)) return input.map(normalizeHash);

  const text = String(input).trim();
  if (!text) return [];

  let chunks;
  if (text.startsWith("[")) {
    chunks = JSON.parse(text);
  } else if (/^0x[0-9a-fA-F]{64}$/.test(text)) {
    chunks = [text];
  } else if (/[,\s]/.test(text)) {
    chunks = text.split(/[\s,]+/).filter(Boolean);
  } else {
    const raw = text.replace(/^0x/i, "");
    if (raw.length === 0 || raw.length % 64 !== 0) {
      throw new Error("Proof must be a list of 32-byte hashes.");
    }
    chunks = raw.match(/.{64}/g) ?? [];
  }

  return chunks.map(normalizeHash);
}

function normalizeHash(value) {
  const hash = String(value).trim();
  if (!isHexString(hash, 32)) {
    throw new Error(`Invalid proof node: ${hash.slice(0, 14)}…`);
  }
  return hash.toLowerCase();
}

function normalizeSecret(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const secret = String(value).trim();
  if (!isHexString(secret, 32)) {
    throw new Error("Claim secret must be 32 bytes of hex (0x + 64 characters).");
  }
  return secret.toLowerCase();
}

// ---------------------------------------------------------------------------
// Demo proof files (served from .glowpet-demo/proofs by the dev server)
// ---------------------------------------------------------------------------

export async function loadClaimFile(serial) {
  if (!PROOF_BASE_URL) return null;

  const response = await fetch(`${PROOF_BASE_URL}/${serial}.json`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Proof file request failed (${response.status}).`);

  // A static host may answer unknown paths with the SPA's index.html.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;

  const data = await response.json();
  assertClaimProtocol(data.protocolVersion);
  return {
    ...data,
    proof: Array.isArray(data.proof) ? data.proof.map(normalizeHash) : parseProof(data.proof),
  };
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

const ERROR_TEXT = {
  InvalidConfig: "This series is not configured correctly on the contract.",
  InvalidSerial: "That serial does not exist in this series.",
  InvalidCredentialSigner: "The charm's signing credential is missing or invalid.",
  InvalidRecipient: "The recipient address is missing or invalid.",
  InvalidProof: "This claim credential is not valid for that serial.",
  InvalidSignature: "The claim authorization does not match this charm and recipient.",
  SignatureExpired: "The claim signature expired. Sign again to continue.",
  SeriesExists: "This series already exists.",
  SeriesNotOpen: "This series is closed and no longer accepting claims.",
  AlreadyClaimed: "This charm has already been activated.",
  MaxSupplyReached: "Every charm in this series has been claimed.",
  StageMustIncrease: "A pet can only move to a higher stage.",
};

export function describeError(error) {
  if (!error) return "Something went wrong.";

  if (error.code === "ACTION_REJECTED" || error.code === 4001) {
    return "Transaction cancelled in the wallet.";
  }
  if (
    error.code === "INSUFFICIENT_FUNDS" ||
    /insufficient funds/i.test(error.message ?? "")
  ) {
    return "This wallet needs a little Sepolia ETH for gas.";
  }

  const revertName = error.revert?.name ?? error.info?.error?.name;
  if (revertName && ERROR_TEXT[revertName]) return ERROR_TEXT[revertName];

  if (error.reason) return error.reason;
  if (error.shortMessage) return error.shortMessage;
  if (error.message) return error.message.split("\n")[0];
  return String(error);
}

// ---------------------------------------------------------------------------
// Tiny internal utilities
// ---------------------------------------------------------------------------

function toBigInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}
