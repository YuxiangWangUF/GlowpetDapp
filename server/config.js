import { Wallet, getAddress, isAddress } from "ethers";
import { AppError } from "./lib/errors.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);
const DEFAULT_CHAIN_ID = 11155111n;
const DEFAULT_TTL_SECONDS = 600;

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return String(value).trim();
}

function positiveBigInt(value, name, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) throw new Error(`${name} must be a positive integer.`);
  const parsed = BigInt(text);
  if (parsed <= 0n) throw new Error(`${name} must be greater than zero.`);
  return parsed;
}

function positiveInteger(value, name, fallback) {
  const parsed = positiveBigInt(value, name, fallback === null ? null : BigInt(fallback));
  if (parsed === null) return fallback;
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large.`);
  return Number(parsed);
}

function nonNegativeInteger(value, name, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) throw new Error(`${name} must be a non-negative integer.`);
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large.`);
  return Number(parsed);
}

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  const text = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  throw new Error(`${value} is not a boolean.`);
}

function list(value, fallback = "") {
  return String(value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parse and validate server configuration. No defaults are invented for fee
 * limits: if a sponsor limit is missing, broadcast stays disabled.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV ?? "development").toLowerCase();
  const production = nodeEnv === "production";
  const authMode = String(env.AUTH_MODE ?? "privy").toLowerCase();
  if (!["privy", "mock"].includes(authMode)) {
    throw new Error("AUTH_MODE must be privy or mock.");
  }
  if (production && authMode === "mock") {
    throw new Error("AUTH_MODE=mock is not allowed when NODE_ENV=production.");
  }

  const chainId = positiveBigInt(env.CHAIN_ID, "CHAIN_ID", DEFAULT_CHAIN_ID);
  const contractAddress = String(env.GLOWPET_ADDRESS ?? "").trim();
  const chainConfigured = isAddress(contractAddress) && !/^0x0{40}$/i.test(contractAddress);

  const allowedSeriesIds = new Set(list(env.ALLOWED_SERIES_IDS, "1"));
  for (const id of allowedSeriesIds) {
    if (!/^[0-9]+$/.test(id)) throw new Error(`ALLOWED_SERIES_IDS contains invalid series id: ${id}`);
  }

  const relayerEnabled = booleanValue(env.RELAYER_ENABLED, false);
  const relayerPrivateKey = String(env.RELAYER_PRIVATE_KEY ?? "").trim();
  let relayerAddress = "";
  if (relayerPrivateKey) {
    try {
      relayerAddress = new Wallet(relayerPrivateKey).address;
    } catch {
      throw new Error("RELAYER_PRIVATE_KEY is not a valid secp256k1 private key.");
    }
  }
  if (relayerEnabled && !relayerPrivateKey) {
    throw new Error("RELAYER_ENABLED=true requires RELAYER_PRIVATE_KEY.");
  }

  const maxGasPerTx = positiveBigInt(env.RELAYER_MAX_GAS_PER_TX, "RELAYER_MAX_GAS_PER_TX");
  const maxFeePerGasWei = positiveBigInt(env.RELAYER_MAX_FEE_PER_GAS_WEI, "RELAYER_MAX_FEE_PER_GAS_WEI");
  const dailyBudgetWei = positiveBigInt(env.RELAYER_DAILY_BUDGET_WEI, "RELAYER_DAILY_BUDGET_WEI");
  const limitsConfigured = Boolean(maxGasPerTx && maxFeePerGasWei && dailyBudgetWei);
  if (relayerEnabled && !limitsConfigured) {
    throw new Error(
      "RELAYER_ENABLED=true requires RELAYER_MAX_GAS_PER_TX, RELAYER_MAX_FEE_PER_GAS_WEI and RELAYER_DAILY_BUDGET_WEI.",
    );
  }
  const sponsorPaused = !relayerEnabled || !relayerAddress || !limitsConfigured || !chainConfigured;

  const claimConfirmations = positiveInteger(env.CLAIM_CONFIRMATIONS, "CLAIM_CONFIRMATIONS", 2);
  const claimAuthMaxTtlSeconds = positiveInteger(
    env.CLAIM_AUTH_MAX_TTL_SECONDS, "CLAIM_AUTH_MAX_TTL_SECONDS", DEFAULT_TTL_SECONDS,
  );
  if (claimAuthMaxTtlSeconds > 86_400) {
    throw new Error("CLAIM_AUTH_MAX_TTL_SECONDS must be at most 86400.");
  }

  const authConfigured = authMode === "mock"
    || Boolean(String(env.PRIVY_APP_ID ?? "").trim() && String(env.PRIVY_APP_SECRET ?? "").trim());
  if (production && authMode === "privy" && !authConfigured) {
    throw new Error("NODE_ENV=production requires PRIVY_APP_ID and PRIVY_APP_SECRET.");
  }

  return Object.freeze({
    nodeEnv,
    production,
    authMode,
    authConfigured,
    privyAppId: String(env.PRIVY_APP_ID ?? "").trim(),
    privyAppSecret: String(env.PRIVY_APP_SECRET ?? "").trim(),
    privyVerificationKey: String(env.PRIVY_JWT_VERIFICATION_KEY ?? "").trim(),
    databaseUrl: String(env.DATABASE_URL ?? "").trim(),
    port: positiveInteger(env.PORT, "PORT", 3001),
    logLevel: String(env.LOG_LEVEL ?? (production ? "info" : "warn")).toLowerCase(),
    trustProxy: booleanValue(env.TRUST_PROXY, false),
    allowedOrigins: list(env.ALLOWED_ORIGINS, "http://localhost:5173,http://127.0.0.1:5173"),
    chainId,
    chainConfigured,
    contractAddress: chainConfigured ? getAddress(contractAddress) : "",
    rpcUrl: String(env.RPC_URL ?? "").trim(),
    deployBlock: nonNegativeInteger(env.DEPLOY_BLOCK, "DEPLOY_BLOCK", 0),
    allowedSeriesIds,
    relayerEnabled,
    relayerAddress,
    relayerPrivateKey,
    sponsorPaused,
    maxGasPerTx: maxGasPerTx ?? null,
    maxFeePerGasWei: maxFeePerGasWei ?? null,
    dailyBudgetWei: dailyBudgetWei ?? null,
    claimConfirmations,
    claimAuthMaxTtlSeconds,
    walletBindingVersion: 1,
    gardenRulesVersion: "1",
    claimRateLimitPerMinute: positiveInteger(env.CLAIM_RATE_LIMIT_PER_MINUTE, "CLAIM_RATE_LIMIT_PER_MINUTE", 10),
    claimRateLimitPerHour: positiveInteger(env.CLAIM_RATE_LIMIT_PER_HOUR, "CLAIM_RATE_LIMIT_PER_HOUR", 60),
  });
}

export function requireDatabase(config) {
  if (!config.databaseUrl) {
    throw new AppError("SERVICE_NOT_CONFIGURED", "The account database is not configured.", 503);
  }
}
