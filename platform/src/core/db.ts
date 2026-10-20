import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Either the pool or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Env: DATABASE_CA_CERT = PEM of the CA that signed the server certificate (Supabase publishes one) and enables full
// verification. DATABASE_SSL = `no-verify` (encrypt but do not authenticate the server, documented risk) or `disable`.
/**
 * TLS settings for a connection string. A local server needs none. A remote one (Supabase, a future server in
 * Kazakhstan) must use TLS and, by default, must be VERIFIED: give the CA in DATABASE_CA_CERT, or consciously opt
 * out with DATABASE_SSL=no-verify. Anything else is refused instead of silently connecting unauthenticated.
 */
export function sslFor(connectionString: string, env: Record<string, string | undefined> = process.env): false | pg.ClientConfig["ssl"] {
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (LOCAL_HOSTS.has(host)) return false;
  if (env.DATABASE_SSL === "disable") return false;
  if (env.DATABASE_CA_CERT) return { ca: env.DATABASE_CA_CERT.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  if (env.DATABASE_SSL === "no-verify") return { rejectUnauthorized: false };
  throw new Error(
    "Remote database without a CA: set DATABASE_CA_CERT (recommended) or DATABASE_SSL=no-verify (encrypted but not authenticated)",
  );
}

export interface PoolOptions {
  max?: number;
  /** Tests only: lets raw SQL in a test refer to unqualified names. The application always qualifies (`bb.users`). */
  searchPath?: string;
}

/**
 * Pool tuned for serverless + a transaction pooler (Supabase Supavisor): small, short-lived idle connections, no
 * session state. Nothing here relies on SET/search_path/prepared statements surviving between queries.
 */
export function createPool(connectionString: string, options: PoolOptions | number = {}): pg.Pool {
  const opts = typeof options === "number" ? { max: options } : options;
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? Number(process.env.DATABASE_POOL_MAX ?? 3),
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 8_000,
    ssl: sslFor(connectionString),
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  });
  // An idle client dying must not crash the process.
  pool.on("error", () => {});
  return pool;
}

/** Statement timeout inside a transaction: SET LOCAL is the form that works through a transaction pooler. */
const TX_STATEMENT_TIMEOUT_MS = 15_000;

/** Runs `fn` in one transaction: COMMIT on success, ROLLBACK on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${TX_STATEMENT_TIMEOUT_MS}`);
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
