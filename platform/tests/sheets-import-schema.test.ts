import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPool, type Pool } from "../src/core/db.ts";
import { migrate } from "../src/core/migrate.ts";
import { checkReadAccess, detectSchemaVersion, loadCatalog, loadCrmSnapshot, REQUIRED_COLUMNS } from "../src/core/sheets-import/index.ts";
import { MIGRATIONS_DIR, makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

const GRANT_SQL = readFileSync(join(import.meta.dirname, "..", "scripts", "sql", "sheets-ro-grant.sql"), "utf8");
const ROLE_SCRIPT = join(import.meta.dirname, "..", "scripts", "sheets-ro-role.sh");
const FUTURE = "2099-06-15";

/** A test database with migrations up to (and including) `upTo`; 14 = what production runs today, 15 = after the kernel change. */
async function dbAt(upTo: number): Promise<TestDb> {
  const db = await startTestDb({ migrate: false });
  const dir = mkdtempSync(join(tmpdir(), "bbmig-"));
  for (const f of readdirSync(MIGRATIONS_DIR)) if (/^\d+_/.test(f) && Number(f.slice(0, 3)) <= upTo) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  await migrate(db.pool, dir);
  rmSync(dir, { recursive: true, force: true });
  await seedFromSite(db.pool);
  return db;
}

async function seedBooking(pool: Pool, opts: { slotId: number; phone: string; room?: string }) {
  const user = await makeUser(pool, "owner", `o${opts.slotId}${opts.phone.slice(-3)}@example.test`);
  const c = await pool.query<{ id: string }>(
    "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('Тест', 'тест', $1, 'manual') RETURNING id", [opts.phone]);
  const room = opts.room ?? "magic-room";
  const pkg = (await pool.query<{ id: string }>("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, created_by)
     VALUES ('booking', $1, $2, $3, $4, $5, 8, 1000, 'base', $6) RETURNING id`, [FUTURE, opts.slotId, room, c.rows[0].id, pkg, user.id]);
  return r.rows[0].id;
}

/** The read-only role is created the way the VPS script creates it (role first, grants second), then used over a real connection. */
async function readOnlyPool(db: TestDb): Promise<Pool> {
  await db.pool.query("CREATE ROLE bb_sheets_ro LOGIN PASSWORD 'ro-test-pw' NOSUPERUSER");
  await db.pool.query("ALTER ROLE bb_sheets_ro SET default_transaction_read_only = on");
  await db.pool.query(GRANT_SQL);
  const url = new URL(db.url);
  url.username = "bb_sheets_ro"; url.password = "ro-test-pw";
  const p = createPool(url.toString(), { max: 2 });
  return p;
}

for (const [label, upTo] of [["pre-015 (production today)", 14], ["post-015 (after the kernel change)", 15]] as const) {
  describe(`sheets import against schema ${label}`, () => {
    let db: TestDb, ro: Pool;
    before(async () => { db = await dbAt(upTo); ro = await readOnlyPool(db); });
    after(async () => { await ro?.end(); await db?.stop(); });

    it("detects the schema version", async () => {
      assert.equal(await detectSchemaVersion(db.pool), upTo === 14 ? "pre-015" : "post-015");
      assert.equal(await detectSchemaVersion(ro), upTo === 14 ? "pre-015" : "post-015");
    });

    it("the column-level grant satisfies every required column and nothing is writable", async () => {
      const a = await checkReadAccess(ro);
      assert.deepEqual(a.missing, []);
      assert.deepEqual(a.writable, []);
      assert.deepEqual(a.rlsBlocked, []);
      assert.equal(a.superuser, false);
      assert.equal(a.ok, true);
      assert.deepEqual(a.overbroadRead, [], "the role must not be able to read any bb table as a whole");
    });

    it("loads the CRM snapshot as the limited role, including a whole-hour booking", async () => {
      await seedBooking(db.pool, { slotId: upTo === 14 ? 2 : 6, phone: "+77071112233" }); // 14:00 (pre) / 13:00 (post)
      const crm = await loadCrmSnapshot(ro);
      assert.equal(crm.reservations.length, 1);
      assert.equal(crm.reservations[0].date, FUTURE);
      assert.equal(crm.reservations[0].startTime, upTo === 14 ? "14:00" : "13:00");
      assert.equal((await loadCatalog(ro)).rooms.length > 0, true);
    });

    it("the role cannot write, cannot read payment or contact-detail columns", async () => {
      await assert.rejects(ro.query("UPDATE bb.rooms SET name = 'x'"), /permission denied|read-only/);
      await assert.rejects(ro.query("INSERT INTO bb.rooms (id, name) VALUES ('zz','zz')"), /permission denied|read-only/);
      await assert.rejects(ro.query("SELECT price_kzt FROM bb.slot_reservations"), /permission denied/);
      await assert.rejects(ro.query("SELECT note FROM bb.slot_reservations"), /permission denied/);
      await assert.rejects(ro.query("SELECT name FROM bb.contacts"), /permission denied/);
      await assert.rejects(ro.query("SELECT * FROM bb.users"), /permission denied/);
    });

    it("the preflight reports a missing privilege by name, and a write-capable role as not ok", async () => {
      await db.pool.query("REVOKE SELECT (phone_e164) ON bb.contacts FROM bb_sheets_ro");
      const broken = await checkReadAccess(ro);
      assert.deepEqual(broken.missing, ["contacts.phone_e164"]);
      assert.equal(broken.ok, false);
      await db.pool.query(GRANT_SQL); // the grant is idempotent and repairs it
      assert.equal((await checkReadAccess(ro)).ok, true);
      const admin = await checkReadAccess(db.pool); // the test cluster user is a superuser
      assert.equal(admin.ok, false);
      assert.equal(admin.superuser, true);
      assert.ok(admin.writable.includes("slot_reservations"));
    });

    it("without BYPASSRLS the role would silently read zero rows, and the preflight says so", async () => {
      await db.pool.query("ALTER ROLE bb_sheets_ro NOBYPASSRLS");
      const a = await checkReadAccess(ro);
      assert.equal(a.ok, false);
      assert.ok(a.rlsBlocked.includes("slot_reservations"));
      await db.pool.query(GRANT_SQL);
      assert.equal((await checkReadAccess(ro)).ok, true);
    });

    it("REQUIRED_COLUMNS matches the grant SQL for this version", () => {
      const cols = REQUIRED_COLUMNS[upTo === 14 ? "pre-015" : "post-015"];
      for (const [table, list] of Object.entries(cols)) {
        const m = new RegExp(`GRANT SELECT \\(([^)]*)\\) ON bb\\.${table} TO`, "g");
        const granted = new Set<string>();
        for (const hit of GRANT_SQL.matchAll(m)) for (const c of hit[1].split(",")) granted.add(c.trim());
        for (const c of list) assert.ok(granted.has(c), `${table}.${c} is required but not granted`);
      }
    });
  });
}

describe("post-015 keeps exact minutes", () => {
  let db: TestDb, ro: Pool;
  before(async () => { db = await dbAt(15); ro = await readOnlyPool(db); });
  after(async () => { await ro?.end(); await db?.stop(); });

  it("reads 13:15 and 16:40 exactly, not rounded", async () => {
    const user = await makeUser(db.pool, "owner");
    const pkg = (await db.pool.query<{ id: string }>("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
    const contact = (await db.pool.query<{ id: string }>("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('Тест','тест','+77070000001','manual') RETURNING id")).rows[0].id;
    // The current kernel only writes whole hours. A future interval writer will write minutes; this test stands in for it
    // by bypassing the guard trigger in this private scratch database only (the exclusion constraint stays on).
    const c = await db.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const [room, t] of [["magic-room", "13:15"], ["ice-room", "16:40"]] as const) {
        await c.query(
          `INSERT INTO bb.slot_reservations (kind, slot_date, room_id, contact_id, package_id, children, price_kzt, price_source, created_by, starts_at, ends_at)
           VALUES ('booking', $1, $2, $3, $4, 8, 1000, 'base', $5, ($1::date + $6::time) AT TIME ZONE 'Asia/Almaty', ($1::date + $6::time + interval '4 hours') AT TIME ZONE 'Asia/Almaty')`,
          [FUTURE, room, contact, pkg, user.id, t]);
      }
    } finally { await c.query("RESET session_replication_role"); c.release(); }
    const times = (await loadCrmSnapshot(ro)).reservations.map((r) => r.startTime).sort();
    assert.deepEqual(times, ["13:15", "16:40"]);
  });
});

describe("sheets-ro-role.sh (create / status / revoke) on a real cluster", { skip: !existsSync("/opt/homebrew/bin/psql") && !process.env.PSQL_BIN ? "psql not installed" : false }, () => {
  let db: TestDb, home: string;
  before(async () => { db = await dbAt(14); home = mkdtempSync(join(tmpdir(), "bbro-")); });
  after(async () => { await db?.stop(); rmSync(home, { recursive: true, force: true }); });

  const run = (cmd: string) => {
    const env = { ...process.env, PSQL_ADMIN: `psql -X -q -v ON_ERROR_STOP=1 ${db.url}`, URL_FILE: join(home, "ro.url"), TUNNEL_PORT: new URL(db.url).port, DB_NAME: "postgres", TTL_HOURS: "24" };
    return execFileSync("bash", [ROLE_SCRIPT, cmd], { env, encoding: "utf8" });
  };

  it("creates the role, keeps the URL only in a 600 file, never prints the password, and the URL really connects", async () => {
    const out = run("create");
    const file = join(home, "ro.url");
    const url = readFileSync(file, "utf8").trim();
    const pw = new URL(url).password;
    assert.ok(pw.length >= 32);
    assert.ok(!out.includes(pw), "password must not be printed");
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    assert.ok(!(await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro' AND rolvaliduntil IS NULL")).rowCount, "role expires");
    const pool = createPool(url.replace(/@127\.0\.0\.1:\d+\//, `@127.0.0.1:${new URL(db.url).port}/`), { max: 1 });
    try { assert.equal((await checkReadAccess(pool)).ok, true); } finally { await pool.end(); }
    assert.throws(() => run("create"), /already exists/);
  });

  it("revoke drops the role and shreds the file", async () => {
    run("revoke");
    assert.equal(existsSync(join(home, "ro.url")), false);
    assert.equal((await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro'")).rowCount, 0);
    assert.match(run("status"), /absent/);
  });
});
