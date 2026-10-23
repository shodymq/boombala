// Logical export of the closed schema `bb` (structure comes from the migrations, this file carries the DATA) with checksums.
//   DATABASE_URL=… EXPORT_DIR=/secure/path npm run db:export
// - one consistent snapshot (REPEATABLE READ, READ ONLY), one file per table, a manifest with row counts, sha256 of every file and a
//   content hash computed by the database (compared with the restore);
// - the files hold personal data once real data exists: the directory must be OUTSIDE the repository, it is created private (0700/0600);
// - nothing in the output contains a connection string or a password.
// TLS: a remote host needs DATABASE_CA_CERT (PEM) or, consciously, DATABASE_SSL=no-verify. Local hosts need none.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { FORMAT, rowHashSql, sslFor } from "./lib/bb-export.mjs";

const url = process.env.DATABASE_URL;
const dirArg = process.env.EXPORT_DIR;
if (!url || !dirArg) throw new Error("DATABASE_URL and EXPORT_DIR are required");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = resolve(dirArg);
if (!relative(repoRoot, out).startsWith("..")) throw new Error("EXPORT_DIR must be outside the repository (the files hold personal data)");

const dirExistsEmpty = (d) => {
  try {
    return readdirSync(d).length === 0;
  } catch {
    return true;
  }
};
if (!dirExistsEmpty(out)) throw new Error("EXPORT_DIR must be empty or new");
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);

const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET TIME ZONE 'UTC'");
  const version = (await client.query("SHOW server_version")).rows[0].server_version;
  const tables = (await client.query("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r' ORDER BY 1")).rows.map((r) => r.t);
  const migrations = (await client.query("SELECT name, checksum FROM bb.schema_migrations ORDER BY name")).rows;
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), serverVersion: version, migrations, tables: {}, sequences: {} };
  for (const t of tables) {
    const r = await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x::text), '[]'::jsonb)::text AS j, md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x::text), '[]'::jsonb)::text) AS m FROM bb.${t} x`);
    const text = r.rows[0].j;
    const sha = createHash("sha256").update(text).digest("hex");
    if (createHash("md5").update(text).digest("hex") !== r.rows[0].m) throw new Error(`transport check failed for ${t}`);
    const file = `${t}.json`;
    writeFileSync(join(out, file), text, { mode: 0o600 });
    const h = (await client.query(rowHashSql(t))).rows[0];
    manifest.tables[t] = { file, rows: h.n, sha256: sha, rowHash: h.h };
  }
  for (const s of (await client.query("SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'bb'")).rows) manifest.sequences[s.sequencename] = s.last_value === null ? null : String(s.last_value);
  await client.query("COMMIT");
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const total = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(`export ok: ${tables.length} tables, ${total} rows, ${migrations.length} migrations, server ${version}`);
} finally {
  await client.end();
}
