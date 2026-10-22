import "server-only";
import { createPool, type Pool } from "../core/db.ts";
import { requireDatabaseUrl } from "./env.ts";

// One pool per server process (kept across hot reloads in development).
const globalForPool = globalThis as unknown as { __bbPool?: Pool };

export function getPool(): Pool {
  globalForPool.__bbPool ??= createPool(requireDatabaseUrl());
  return globalForPool.__bbPool;
}
