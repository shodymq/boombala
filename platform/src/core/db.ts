import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Either the pool or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A runaway query must never hold the admin panel hostage.
    statement_timeout: 15_000,
  });
  // An idle client dying must not crash the process.
  pool.on("error", () => {});
  return pool;
}

/** Runs `fn` in one transaction: COMMIT on success, ROLLBACK on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the useful one */
    }
    throw error;
  } finally {
    client.release();
  }
}
