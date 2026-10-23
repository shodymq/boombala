// Restores an export made by `npm run db:export` into a database whose schema `bb` was created by the SAME migrations and is EMPTY.
//   DATABASE_URL=… EXPORT_DIR=/secure/path npm run db:restore
// Order of work: verify sha256 of every file, refuse a non-empty target or different migrations, load in foreign-key order inside ONE
// transaction (triggers of the application tables are switched off for the load and back on), restore sequence counters, then compare the
// row count and the content hash of every table with the manifest. Any difference rolls everything back.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { FORMAT, rowHashSql, sslFor } from "./lib/bb-export.mjs";

const url = process.env.DATABASE_URL;
const dir = process.env.EXPORT_DIR ? resolve(process.env.EXPORT_DIR) : "";
if (!url || !dir) throw new Error("DATABASE_URL and EXPORT_DIR are required");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
if (manifest.format !== FORMAT) throw new Error("unknown export format");
const files = {};
for (const [t, info] of Object.entries(manifest.tables)) {
  const text = readFileSync(join(dir, info.file), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== info.sha256) throw new Error(`checksum mismatch: ${info.file}`);
  files[t] = text;
}
console.log(`files verified: ${Object.keys(files).length}`);

const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
await client.connect();
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
try {
  const have = (await client.query("SELECT name, checksum FROM bb.schema_migrations ORDER BY name")).rows;
  if (JSON.stringify(have) !== JSON.stringify(manifest.migrations)) throw new Error("the target has different migrations (names or checksums): apply the same migrations first");
  const tables = (await client.query("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r'")).rows.map((r) => r.t);
  if (JSON.stringify([...tables].sort()) !== JSON.stringify(Object.keys(manifest.tables).sort())) throw new Error("the target has a different set of tables");
  // Rows that the migrations themselves create (the three time slots, the single retention-settings row) are replaced by the exported ones.
const SEEDED_BY_MIGRATIONS = ["time_slots", "retention_settings"];
for (const t of tables) if (t !== "schema_migrations" && !SEEDED_BY_MIGRATIONS.includes(t) && Number((await client.query(`SELECT count(*) n FROM bb.${t}`)).rows[0].n) > 0) throw new Error(`the target table ${t} is not empty`);

  // foreign-key order (parents first)
  const deps = (await client.query("SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = 'bb'")).rows.map((r) => [r.child.replace(/^bb\./, ""), r.parent.replace(/^bb\./, "")]);
  const order = [];
  const done = new Set();
  while (order.length < tables.length) {
    const next = tables.filter((t) => !done.has(t) && deps.every(([c, p]) => c !== t || p === t || done.has(p)));
    if (!next.length) throw new Error("cyclic foreign keys");
    for (const t of next.sort()) (done.add(t), order.push(t));
  }

  await client.query("BEGIN");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const loaded = order.filter((t) => t !== "schema_migrations");
  for (const t of loaded) await client.query(`ALTER TABLE bb.${t} DISABLE TRIGGER USER`);
  for (const t of SEEDED_BY_MIGRATIONS) await client.query(`DELETE FROM bb.${t}`);
  // Registrations made before migration 013 have no declared number of children (NULL, never invented). The 013 constraint is NOT VALID
  // (it guards new rows only), so it is lifted for the load and put back exactly as it was.
  const hasConstraint = (await client.query("SELECT 1 FROM pg_constraint WHERE conname = 'consent_registrations_children_required'")).rowCount > 0;
  const legacyNull = hasConstraint && files.consent_registrations && JSON.parse(files.consent_registrations).some((r) => r.children_count === null || r.children_count === undefined);
  if (legacyNull) await client.query("ALTER TABLE bb.consent_registrations DROP CONSTRAINT consent_registrations_children_required");
  for (const t of loaded) {
    const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'bb' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [t])).rows.map((r) => `"${r.column_name}"`).join(", ");
    if (manifest.tables[t].rows) await client.query(`INSERT INTO bb.${t} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM jsonb_populate_recordset(null::bb.${t}, $1::jsonb)`, [files[t]]);
  }
  if (legacyNull) await client.query("ALTER TABLE bb.consent_registrations ADD CONSTRAINT consent_registrations_children_required CHECK (children_count IS NOT NULL) NOT VALID");
  for (const t of loaded) await client.query(`ALTER TABLE bb.${t} ENABLE TRIGGER USER`);
  for (const [seq, last] of Object.entries(manifest.sequences)) if (last !== null) await client.query("SELECT setval($1::regclass, $2::bigint, true)", [`bb.${seq}`, last]);
  for (const t of order) {
    const h = (await client.query(rowHashSql(t))).rows[0];
    // schema_migrations carries the moment each migration was applied on THIS server: names and checksums were compared above.
    const same = h.n === manifest.tables[t].rows && (t === "schema_migrations" || h.h === manifest.tables[t].rowHash);
    ok(same, `${t}: ${h.n} rows${t === "schema_migrations" ? ", names and checksums equal" : ", content hash equal"}`);
  }
  if (fails) throw new Error("verification failed: rolled back");
  await client.query("COMMIT");
  console.log("restore ok: every table matches the export");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`restore failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
