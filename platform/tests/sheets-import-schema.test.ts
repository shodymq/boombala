import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
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

    it("RLS: exactly one SELECT-only policy per needed table, for this role only; no BYPASSRLS", async () => {
      const pol = await db.pool.query<{ tablename: string; cmd: string; roles: string }>(
        "SELECT tablename, cmd, roles::text AS roles FROM pg_policies WHERE schemaname = 'bb' AND policyname = 'sheets_ro_select' ORDER BY tablename");
      const expected = Object.keys(REQUIRED_COLUMNS[upTo === 14 ? "pre-015" : "post-015"]).sort();
      assert.deepEqual(pol.rows.map((r) => r.tablename), expected);
      for (const r of pol.rows) { assert.equal(r.cmd, "SELECT"); assert.equal(r.roles, "{bb_sheets_ro}"); }
      assert.equal((await db.pool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'bb_sheets_ro'")).rows[0].rolbypassrls, false);
      assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'bb' AND policyname <> 'sheets_ro_select'")).rows[0].n, 0);
    });

    it("RLS: the policy does not leak to other roles, and does not unlock tables or columns outside the grant", async () => {
      await db.pool.query("CREATE ROLE other_ro LOGIN PASSWORD 'x' NOSUPERUSER");
      await db.pool.query("GRANT USAGE ON SCHEMA bb TO other_ro; GRANT SELECT ON bb.rooms TO other_ro");
      const u = new URL(db.url); u.username = "other_ro"; u.password = "x";
      const other = createPool(u.toString(), { max: 1 });
      try { assert.equal((await other.query("SELECT count(*)::int AS n FROM bb.rooms")).rows[0].n, 0, "a role without a policy still sees nothing"); } finally { await other.end(); }
      const n = (await db.pool.query("SELECT count(*)::int AS n FROM bb.rooms")).rows[0].n;
      assert.equal((await ro.query("SELECT count(*)::int AS n FROM bb.rooms")).rows[0].n, n, "bb_sheets_ro sees every room");
      for (const t of ["users", "sessions", "legal_documents", "audit_log"]) {
        const exists = (await db.pool.query("SELECT to_regclass($1) AS r", [`bb.${t}`])).rows[0].r;
        if (exists) await assert.rejects(ro.query(`SELECT 1 FROM bb.${t} LIMIT 1`), /permission denied/, t);
      }
      await assert.rejects(ro.query("DELETE FROM bb.rooms"), /permission denied|read-only/);
      await db.pool.query("DROP OWNED BY other_ro; DROP ROLE other_ro");
    });

    it("the preflight reports a table whose policy is missing as RLS-blocked, and the grant repairs it", async () => {
      await db.pool.query("DROP POLICY sheets_ro_select ON bb.slot_reservations");
      const a = await checkReadAccess(ro);
      assert.equal(a.ok, false);
      assert.deepEqual(a.rlsBlocked, ["slot_reservations"]);
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
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'sheets_ro_select'")).rows[0].n, 0, "policies are removed with the role");
  });
});

describe("sheets-vps-run.sh: everything on the VPS, no tunnel", { skip: !existsSync("/opt/homebrew/bin/psql") && !process.env.PSQL_BIN ? "psql not installed" : false }, () => {
  let db: TestDb, home: string;
  const PHONE_DIGITS = "7071234567";
  const csv = () => {
    const f = join(home, "b.csv");
    writeFileSync(f, ["Дата,Время,Пакет,Аниматор,Комната,Клиент,Телефон,Ребенок,Возраст,Предоплата,Количество детей,Количество взрослых",
      `20.11.2099,16:40,x,А,y,Секретный Клиент,8 ${PHONE_DIGITS.slice(0, 3)} ${PHONE_DIGITS.slice(3)},Малыш,7,10к,10,5`].join("\n"));
    return f;
  };
  const adminCmd = () => `psql -X -q -v ON_ERROR_STOP=1 ${db.url}`;
  const port = () => new URL(db.url).port;
  const run = (args: string[]) => {
    const env = { ...process.env, HOME: home, REPORT_DIR: home, PSQL_ADMIN: adminCmd(), DB_NAME: "postgres", DB_PORT: port() };
    try { return { code: 0, out: execFileSync("bash", [join(import.meta.dirname, "..", "scripts", "sheets-vps-run.sh"), csv(), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: x.stdout ?? "", err: x.stderr ?? "" }; }
  };
  before(async () => { db = await dbAt(14); home = mkdtempSync(join(tmpdir(), "bbvps-")); await seedBooking(db.pool, { slotId: 2, phone: "+77075550000" }); });
  after(async () => { await db?.stop(); rmSync(home, { recursive: true, force: true }); });

  it("a count mismatch stops before staging, and the temporary role is still revoked", async () => {
    const r = run(["--expect-leads", "48", "--expect-reservations", "0"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /production counts: leads=0 activeReservations=1/);
    assert.match(r.err, /differ from the expected/);
    assert.equal((await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro'")).rowCount, 0, "role revoked after a failed run");
    assert.equal(readdirSync(home).filter((f) => f.startsWith("sheets-report")).length, 0);
  });

  it("with the right counts: reconciles, stages, prints no personal data, leaves no role, keeps a 600 report", async () => {
    const r = run(["--expect-leads", "0", "--expect-reservations", "1"]);
    assert.equal(r.code, 0, r.err);
    const all = r.out + r.err;
    for (const secret of ["Секретный", "Малыш", PHONE_DIGITS, "707 123"]) assert.ok(!all.includes(secret), `output must not contain ${secret}`);
    assert.match(r.out, /"crmSchema": "pre-015"/);
    assert.match(r.out, /"inserted": 1/);
    assert.equal((await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro'")).rowCount, 0);
    const report = readdirSync(home).find((f) => f.startsWith("sheets-report"))!;
    assert.equal((statSync(join(home, report)).mode & 0o777).toString(8), "600");
    assert.equal(readdirSync(home).some((f) => f === "ro.url"), false);
    assert.match(readFileSync(join(home, report), "utf8"), /16:40/, "time kept exactly");
    // production untouched: still exactly the one booking, no payment-ish writes, nothing new in bb
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM bb.slot_reservations")).rows[0].n, 1);
  });

  it("staging is a separate database whose role cannot read bb; a rerun inserts nothing", async () => {
    const stageUrl = readFileSync(join(home, ".bb_sheets_stage.url"), "utf8").trim();
    assert.match(stageUrl, /\/bb_sheet_staging$/);
    assert.notEqual(new URL(stageUrl).pathname, new URL(db.url).pathname);
    const sp = createPool(stageUrl, { max: 1 });
    try {
      assert.equal((await sp.query("SELECT count(*)::int AS n FROM sheet_import.rows")).rows[0].n, 1);
      await assert.rejects(sp.query("SELECT 1 FROM bb.rooms"), /does not exist|permission denied/);
    } finally { await sp.end(); }
    const again = run(["--expect-leads", "0", "--expect-reservations", "1"]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /"inserted": 0/);
    assert.match(again.out, /"unchanged": 1/);
  });
});
