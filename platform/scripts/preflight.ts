import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/core/db.ts";
import { preflight } from "../src/core/preflight.ts";

// Verification step of the deployment: migrations 001..013 -> db:roles -> THIS -> start the applications.
// Prints codes only (never a connection string or a value). Exit code 1 means: do not start.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(2);
}
const pool = createPool(url, { max: 1 });
try {
  const r = await preflight(pool, join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
  if (r.ok) console.log("preflight: OK (migrations, attendance schema, intake function, roles)");
  else {
    console.error(`preflight: ${r.problems.length} problem(s)`);
    for (const p of r.problems) console.error(` - ${p}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
