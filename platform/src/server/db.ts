import "server-only";
import { createPool, type Pool } from "../core/db.ts";
import { instrumentClient } from "../core/perf.ts";
import { requireDatabaseUrl } from "./env.ts";

// One pool per server process (kept across hot reloads in development).
const globalForPool = globalThis as unknown as { __bbPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__bbPool) {
    const pool = createPool(requireDatabaseUrl());
    pool.on("connect", instrumentClient);
    globalForPool.__bbPool = pool;
  }
  return globalForPool.__bbPool;
}
