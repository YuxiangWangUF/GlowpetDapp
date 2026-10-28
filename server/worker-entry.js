import dotenv from "dotenv";
import { Wallet } from "ethers";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { createConfiguredChain } from "./services/chain.js";
import { ClaimWorker } from "./services/claim-worker.js";

dotenv.config({ path: process.env.SERVER_ENV_FILE || "server/.env" });

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
if (!config.relayerEnabled || config.sponsorPaused || !config.relayerAddress) {
  console.error("The relayer is not fully configured. Set RELAYER_ENABLED=true and the fee/budget limits.");
  process.exit(1);
}

const db = await createDatabase({ databaseUrl: config.databaseUrl });
await migrate(db);
const chain = createConfiguredChain(config);
const signer = new Wallet(config.relayerPrivateKey);

const worker = new ClaimWorker({
  db,
  chain,
  config,
  signer,
  logger: {
    info: (fields) => console.info(JSON.stringify(fields)),
    warn: (fields) => console.warn(JSON.stringify(fields)),
    error: (fields) => console.error(JSON.stringify(fields)),
  },
});

worker.start({ intervalMs: 5000 });
console.info(JSON.stringify({ event: "worker_started", chainId: String(config.chainId) }));

async function shutdown(signal) {
  worker.stop();
  await db.close().catch(() => {});
  console.info(JSON.stringify({ event: "worker_stopped", signal }));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
