// Proves that a backup of the `bb` schema can be restored into an empty database with the SAME data and the SAME guarantees
// (row counts, migrations, row security, the double-booking index and the guard triggers).
//   DATABASE_URL=postgres://… node scripts/backup-restore-check.mjs          (a local or test database; it creates and drops one scratch database next to it)
// For Supabase use the DIRECT connection string and a trusted machine; the dump holds personal data once real data exists: encrypt it at rest.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const src = process.env.DATABASE_URL;
if (!src) throw new Error("DATABASE_URL is required");
const scratch = `bb_restore_check_${Date.now().toString(36)}`;
const url = new URL(src);
const admin = new URL(src);
admin.pathname = "/postgres";
const target = new URL(src);
target.pathname = `/${scratch}`;
const dir = mkdtempSync(join(tmpdir(), "bb-backup-"));
const file = join(dir, "bb.dump");
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);

const counts = async (u) => {
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'bb' ORDER BY 1")).rows.map((r) => r.tablename);
    const out = {};
    for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) n FROM bb.${t}`)).rows[0].n);
    const rls = (await c.query("SELECT count(*) n FROM pg_tables WHERE schemaname = 'bb' AND NOT rowsecurity")).rows[0].n;
    const idx = (await c.query("SELECT count(*) n FROM pg_indexes WHERE schemaname = 'bb' AND indexname IN ('slot_reservations_active_cell_idx', 'slot_reservations_active_lead_idx')")).rows[0].n;
    const trg = (await c.query("SELECT count(*) n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND NOT t.tgisinternal")).rows[0].n;
    const mig = (await c.query("SELECT name FROM bb.schema_migrations ORDER BY name")).rows.map((r) => r.name);
    return { out, rlsOff: Number(rls), idx: Number(idx), trg: Number(trg), mig };
  } finally {
    await c.end();
  }
};

const dumpArgs = ["--format=custom", "--no-owner", "--no-privileges", "--schema=bb", "--file", file, src];
const pgEnv = { ...process.env };
try {
  console.log("## backup");
  execFileSync("pg_dump", dumpArgs, { env: pgEnv, stdio: ["ignore", "pipe", "pipe"] });
  ok(statSync(file).size > 1000, `a dump was written (${Math.round(statSync(file).size / 1024)} KB, schema bb only)`);
  const before = await counts(url);

  console.log("## restore into an empty database");
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect();
  await a.query(`CREATE DATABASE ${scratch}`);
  await a.end();
  execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--dbname", target.toString(), file], { env: pgEnv, stdio: ["ignore", "pipe", "pipe"] });
  const after = await counts(target);
  ok(JSON.stringify(before.out) === JSON.stringify(after.out), `every table has the same row count (${Object.keys(after.out).length} tables, ${Object.values(after.out).reduce((s, n) => s + n, 0)} rows)`);
  ok(JSON.stringify(before.mig) === JSON.stringify(after.mig), `the migration list is identical (${after.mig.length} migrations)`);
  ok(after.rlsOff === 0, "row security is ON for every restored table");
  ok(after.idx === 2, "the double-booking unique indexes are restored");
  ok(after.trg === before.trg && after.trg > 0, `all ${after.trg} guard triggers (append-only audit, immutable prices, reservations) are restored`);

  console.log("## the restored database still enforces the rules");
  const t = new pg.Client({ connectionString: target.toString() });
  await t.connect();
  try {
    await t.query("BEGIN");
    let blocked = false;
    try {
      await t.query("UPDATE bb.audit_log SET action = 'x.y'");
    } catch {
      blocked = true;
    }
    await t.query("ROLLBACK");
    ok(blocked || after.out.audit_log === 0, "the audit log is still append-only");
  } finally {
    await t.end();
  }
} catch (e) {
  fails++;
  console.error("  FAIL", e instanceof Error ? e.message.split("\n")[0] : "error");
} finally {
  try {
    const a = new pg.Client({ connectionString: admin.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await a.end();
  } catch {
    console.error(`  note: remove the scratch database ${scratch} by hand`);
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
