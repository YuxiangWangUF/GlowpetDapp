import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS = path.join(here, "migrations");

/**
 * Apply versioned SQL migrations. The migration files are written to be
 * idempotent because the record insert happens after the DDL batch; a crash
 * between the two reruns the same IF NOT EXISTS statements safely.
 */
export async function migrate(db, migrationsDir = DEFAULT_MIGRATIONS) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  const applied = new Set(
    (await db.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await db.exec(sql);
    await db.query(
      "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [file],
    );
  }

  return files.filter((file) => !applied.has(file));
}
