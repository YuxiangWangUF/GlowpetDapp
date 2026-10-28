import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { createDatabase } from "./index.js";
import { migrate } from "./migrate.js";

dotenv.config({ path: process.env.SERVER_ENV_FILE || "server/.env" });

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required. Copy server/.env.example to server/.env first.");
  process.exit(1);
}

const db = await createDatabase({ databaseUrl: config.databaseUrl });
try {
  const applied = await migrate(db);
  console.log(applied.length
    ? `Applied ${applied.length} migration(s): ${applied.join(", ")}`
    : "Database schema is up to date.");
} finally {
  await db.close();
}
