import pg from "pg";

const { Pool } = pg;

function wrapPglite(pglite) {
  return {
    kind: "pglite",
    query: (text, params) => pglite.query(text, params),
    exec: (text) => pglite.exec(text),
    async transaction(callback) {
      return pglite.transaction(async (tx) => callback({
        query: (text, params) => tx.query(text, params),
      }));
    },
    async close() {
      await pglite.close();
    },
  };
}

function wrapPool(pool) {
  return {
    kind: "pg",
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback({
          query: (text, params) => client.query(text, params),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Production uses a real PostgreSQL pool. `pglite:` is a local-development and
 * test convenience that runs the same SQL against an embedded PostgreSQL WASM
 * build; it is never selected by a production config.
 */
export async function createDatabase({ databaseUrl }) {
  const url = String(databaseUrl ?? "").trim();
  if (!url) throw new Error("DATABASE_URL is required.");

  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = url.slice("pglite:".length);
    const pglite = dataDir && dataDir !== "memory" ? new PGlite(dataDir) : new PGlite();
    await pglite.waitReady;
    return wrapPglite(pglite);
  }

  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return wrapPool(pool);
}
