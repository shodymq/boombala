import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/core/db.ts";
import { migrate } from "../src/core/migrate.ts";

// Migrations need a SESSION connection (advisory lock, DDL): the direct/session URL, not the transaction pooler.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(1);
}
const pool = createPool(url, { max: 1 });
try {
  const res = await migrate(pool, join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
  console.log(`applied: ${res.applied.join(", ") || "none"} | already applied: ${res.skipped.length}`);
} finally {
  await pool.end();
}
