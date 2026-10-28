import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { createAuthVerifier } from "./auth/verifier.js";
import { createDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { createAccountRateLimiter } from "./services/rate-limit.js";
import { createClaimService } from "./services/claims.js";
import { createGardenService } from "./services/gardens.js";
import { createConfiguredChain } from "./services/chain.js";
import { ClaimWorker } from "./services/claim-worker.js";
import { Wallet } from "ethers";

dotenv.config({ path: process.env.SERVER_ENV_FILE || "server/.env" });

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required. Copy server/.env.example to server/.env first.");
  process.exit(1);
}

const db = await createDatabase({ databaseUrl: config.databaseUrl });
await migrate(db);

const verifier = createAuthVerifier(config);
let chain = null;
let claimService = null;
let gardenService = null;

if (config.chainConfigured && config.rpcUrl) {
  chain = createConfiguredChain(config);
  claimService = createClaimService({
    db,
    chain,
    config,
    rateLimiter: createAccountRateLimiter({
      perMinute: config.claimRateLimitPerMinute,
      perHour: config.claimRateLimitPerHour,
    }),
  });
  gardenService = createGardenService({ db, chain, config });
} else {
  console.warn("Glowpet contract or RPC is not configured; sponsored claims and cloud gardens are disabled.");
}
if (config.sponsorPaused) {
  console.warn("Relayer is paused: sponsored claims will return SPONSOR_PAUSED.");
}
if (config.authMode === "mock") {
  console.warn("AUTH_MODE=mock is active. This is for local development only.");
}

const app = await buildApp({
  config,
  db,
  chain,
  verifier,
  claimService,
  gardenService,
  logger: { level: config.logLevel },
});

// PGlite is a single-process development database, so a local demo runs the
// worker inside the API process. Production uses a separate `dev:worker`
// process against PostgreSQL.
let inlineWorker = null;
if (process.env.RUN_WORKER_IN_API === "true" && chain && !config.sponsorPaused) {
  inlineWorker = new ClaimWorker({
    db,
    chain,
    config,
    signer: new Wallet(config.relayerPrivateKey),
    logger: {
      info: (fields) => app.log.info(fields),
      warn: (fields) => app.log.warn(fields),
    },
  });
  inlineWorker.start({ intervalMs: 1500 });
  app.log.info({ event: "worker_started_in_api" });
}

try {
  await app.listen({
    port: config.port,
    host: process.env.HOST || "127.0.0.1",
  });
} catch (error) {
  app.log.error({ code: "LISTEN_FAILED" }, "The API could not start.");
  console.error(error.message);
  process.exit(1);
}

async function shutdown(signal) {
  app.log.info({ signal }, "api_shutdown");
  inlineWorker?.stop();
  await app.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
