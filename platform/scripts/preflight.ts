import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/core/db.ts";
import { passkeyConfigFromEnv, passkeyConfigProblems } from "../src/core/passkey-config.ts";
import { preflight } from "../src/core/preflight.ts";

// Verification step of the deployment: migrations 001..014 -> db:roles -> THIS -> start the applications.
// Prints codes only (never a connection string or a value). Exit code 1 means: do not start.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(2);
}
const pool = createPool(url, { max: 1 });
try {
  const r = await preflight(pool, join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
  // A catalog that was never seeded makes every birthday enquiry fail with "rejected" although everything else is green.
  const seeded = (await pool.query<{ p: number; r: number }>("SELECT (SELECT count(*) FROM bb.packages)::int AS p, (SELECT count(*) FROM bb.rooms)::int AS r")).rows[0];
  if (seeded.p === 0 || seeded.r === 0) r.problems.push("catalog_not_seeded: run npm run db:seed");
  // Migration 014 is required by this version whatever PASSKEYS_ENABLED says (checked in preflight()). Passkeys are optional: when they are
  // switched on, their configuration must be in place too.
  if (process.env.PASSKEYS_ENABLED === "1") {
    for (const code of passkeyConfigProblems(passkeyConfigFromEnv(), { production: process.env.PLATFORM_PROFILE === "kz-production" })) r.problems.push(code);
  }
  r.ok = r.problems.length === 0;
  const docs = new Set((await pool.query<{ kind: string }>("SELECT kind::text AS kind FROM bb.legal_documents WHERE status = 'published'")).rows.map((d) => d.kind));
  for (const need of ["visit_rules", "personal_data_consent"]) if (!docs.has(need)) console.log(`note: ${need} is not published yet (the QR registration stays closed until it is)`);
  if (r.ok) console.log("preflight: OK (migrations, attendance schema, intake function, roles, catalog)");
  else {
    console.error(`preflight: ${r.problems.length} problem(s)`);
    for (const p of r.problems) console.error(` - ${p}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
