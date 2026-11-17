import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPool } from "../src/core/db.ts";
import type { TestDb } from "./helpers/db.ts";
import { dbAt, seedBlock, seedBooking, seedLead } from "./helpers/sheets-db.ts";

const S = join(import.meta.dirname, "..", "scripts");
const ADMIN = join(S, "sheets-db-admin.sh"), RUN = join(S, "sheets-vps-run.sh"), WIPE = join(S, "sheets-wipe.sh"), VERIFY = join(S, "sheets-verify-archive.sh");
const HAS_PSQL = existsSync("/opt/homebrew/bin/psql") || existsSync("/usr/bin/psql") || existsSync("/usr/local/bin/psql");
const skip = HAS_PSQL ? false : "psql not installed";

let db: TestDb, home: string, state: string, n = 0;
const port = () => new URL(db.url).port;
const sh = (script: string, args: string[], env: Record<string, string> = {}, cwd?: string) => {
  const r = spawnSync("bash", [script, ...args], { env: { ...process.env, PSQL_ADMIN: `psql -X -q -v ON_ERROR_STOP=1 ${db.url}`, DB_NAME: "postgres", DB_PORT: port(), STATE_DIR: state, HOME: home, ...env }, encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const newWork = () => { const d = join(home, `work${n++}`); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); writeFileSync(join(d, ".bb-sheets-workdir"), ""); return d; };
const scalar = async (sql: string) => (await db.pool.query(sql)).rows[0]?.v;
const exists = {
  role: async (r: string) => Number(await scalar(`SELECT count(*)::int AS v FROM pg_roles WHERE rolname='${r}'`)) > 0,
  db: async (d: string) => Number(await scalar(`SELECT count(*)::int AS v FROM pg_database WHERE datname='${d}'`)) > 0,
  policy: async (p: string) => Number(await scalar(`SELECT count(*)::int AS v FROM pg_policies WHERE policyname='${p}'`)) > 0,
};
const noneOfOurs = async () => { for (const r of ["bb_sheets_ro", "bb_sheets_stage"]) assert.equal(await exists.role(r), false, r); assert.equal(await exists.db("bb_sheet_staging"), false); assert.equal(await exists.policy("sheets_ro_select"), false); };
const precious = async () => { assert.ok(await exists.role("precious_role")); assert.ok(await exists.db("precious_db")); assert.ok(await exists.policy("precious_pol")); };

describe("sheets VPS flow on an isolated PostgreSQL (pre-015 schema)", { skip }, () => {
  before(async () => {
    db = await dbAt(14);
    home = mkdtempSync(join(tmpdir(), "bbflow-")); state = join(home, "state");
    await db.pool.query("CREATE ROLE precious_role NOLOGIN");
    await db.pool.query("CREATE DATABASE precious_db");
    await db.pool.query("CREATE POLICY precious_pol ON bb.rooms FOR SELECT TO precious_role USING (false)");
    await seedLead(db.pool, "+77071230001");
    await seedBooking(db.pool, { slotId: 1, phone: "+77071230002", room: "ice-room" });
    await seedBlock(db.pool, { slotId: 2, room: "magic-room" }); // 14:00-18:00
  });
  after(async () => { await db?.stop(); rmSync(home, { recursive: true, force: true }); });

  for (const [label, setup, check] of [
    ["role bb_sheets_ro", "CREATE ROLE bb_sheets_ro NOLOGIN CONNECTION LIMIT 7", async () => assert.equal(await scalar("SELECT rolconnlimit AS v FROM pg_roles WHERE rolname='bb_sheets_ro'"), 7)],
    ["role bb_sheets_stage", "CREATE ROLE bb_sheets_stage NOLOGIN CONNECTION LIMIT 8", async () => assert.equal(await scalar("SELECT rolconnlimit AS v FROM pg_roles WHERE rolname='bb_sheets_stage'"), 8)],
    ["database bb_sheet_staging", "CREATE DATABASE bb_sheet_staging", async () => assert.ok(await exists.db("bb_sheet_staging"))],
    ["policy sheets_ro_select", "CREATE POLICY sheets_ro_select ON bb.rooms FOR SELECT TO precious_role USING (false)", async () => assert.ok(await exists.policy("sheets_ro_select"))],
  ] as const) {
    it(`fails closed when ${label} already exists: nothing changes, cleanup touches nothing`, async () => {
      await db.pool.query(setup);
      const work = newWork();
      const r = sh(ADMIN, ["prepare", process.env.USER ?? "x", work]);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /REFUSING/);
      await check();
      await precious();
      assert.equal(existsSync(join(state, "manifest.env")), false);
      assert.deepEqual(readdirSync(work), [".bb-sheets-workdir"]);
      const c = sh(ADMIN, ["cleanup"]);
      assert.equal(c.code, 0);
      assert.match(c.out, /nothing removed/);
      await check();
      // only the pre-existing object may exist: nothing else of ours was created by the refused run
      const others = (await db.pool.query<{ n: string }>(
        "SELECT rolname AS n FROM pg_roles WHERE rolname IN ('bb_sheets_ro','bb_sheets_stage') UNION ALL SELECT datname FROM pg_database WHERE datname='bb_sheet_staging' UNION ALL SELECT policyname FROM pg_policies WHERE policyname='sheets_ro_select'")).rows.length;
      assert.equal(others, 1, "exactly the one pre-existing object");
      await db.pool.query(label.startsWith("role") ? `DROP ROLE ${label.split(" ")[1]}` : label.startsWith("database") ? "DROP DATABASE bb_sheet_staging" : "DROP POLICY sheets_ro_select ON bb.rooms");
    });
  }

  it("an injected failure at EVERY step of prepare removes only what this run created", async () => {
    const wrapper = join(home, "flaky-psql.sh");
    writeFileSync(wrapper, '#!/usr/bin/env bash\nc=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "$COUNT_FILE"\nif [ "$c" = "${FAIL_AT:-0}" ]; then echo "injected failure at call $c" >&2; exit 1; fi\nexec psql -X -q -v ON_ERROR_STOP=1 "$DB_URL" "$@"\n');
    const flaky = (failAt: number, work: string) => {
      const count = join(home, "count"); rmSync(count, { force: true });
      return sh(ADMIN, ["prepare", process.env.USER ?? "x", work], { PSQL_ADMIN: `bash ${wrapper}`, COUNT_FILE: count, FAIL_AT: String(failAt), DB_URL: db.url });
    };
    const w0 = newWork();
    const ok = flaky(0, w0);
    assert.equal(ok.code, 0, ok.err);
    const total = Number(readFileSync(join(home, "count"), "utf8"));
    assert.ok(total >= 10, `prepare makes ${total} admin calls`);
    assert.equal(sh(ADMIN, ["cleanup"]).code, 0);
    await noneOfOurs();
    for (let k = 1; k <= total; k += 1) {
      const work = newWork();
      const r = flaky(k, work);
      assert.notEqual(r.code, 0, `failure at call ${k} must fail prepare`);
      await noneOfOurs();
      await precious();
      assert.equal(existsSync(join(state, "manifest.env")), false, `manifest removed after failure at ${k}`);
      assert.deepEqual(readdirSync(work), [".bb-sheets-workdir"], `no credentials left after failure at ${k}`);
    }
  });

  it("success: prepare -> reconcile (counts, blocks, no PII) -> rerun idempotent -> admin cleanup -> wipe", async () => {
    const work = newWork();
    const roomName = (await db.pool.query<{ name: string }>("SELECT name FROM bb.rooms WHERE id='magic-room'")).rows[0].name;
    const csvText = ["Дата,Время,Пакет,Аниматор,Комната,Клиент,Телефон,Ребенок,Возраст,Предоплата,Количество детей,Количество взрослых",
      `15.06.2099,15:00,x,А,${roomName},Секретный Клиент,8 707 123 45 67,Малыш,7,10к,10,5`].join("\n");
    const csv = join(work, "banquets.csv"); writeFileSync(csv, csvText, { mode: 0o600 });
    const prep = sh(ADMIN, ["prepare", process.env.USER ?? "x", work]);
    assert.equal(prep.code, 0, prep.err);
    for (const f of ["ro.url", "stage.url"]) { assert.equal((statSync(join(work, f)).mode & 0o777).toString(8), "600"); }
    for (const f of ["ro", "stage"]) assert.ok(!prep.all.includes(new URL(readFileSync(join(work, `${f}.url`), "utf8").trim()).password), "no password printed");
    assert.equal((statSync(state).mode & 0o777).toString(8), "700");

    // wipe refuses while credentials (and so the staging database) still exist
    const early = sh(WIPE, [work]);
    assert.notEqual(early.code, 0);
    assert.ok(existsSync(csv));

    const run = (args: string[]) => sh(RUN, [csv, ...args], { WORK_DIR: work });
    assert.equal(run([]).code, 2, "explicit expected counts are required");
    const wrong = run(["--expect-leads", "48", "--expect-bookings", "0"]);
    assert.equal(wrong.code, 3);
    assert.match(wrong.err, /production counts: leads=1 activeBookings=1 activeBlocks=1/);
    assert.match(wrong.err, /Do not just rerun/);
    const good = run(["--expect-leads", "1", "--expect-bookings", "1", "--expect-blocks", "1"]);
    assert.equal(good.code, 0, good.err);
    for (const secret of ["Секретный", "Малыш", "707 123", "7071234567", "Заявитель"]) assert.ok(!good.all.includes(secret), `output must not contain ${secret}`);
    const out = JSON.parse(good.out.slice(good.out.indexOf("{"), good.out.lastIndexOf("}") + 1));
    assert.deepEqual(out.productionCounts, { leads: 1, activeBookings: 1, activeBlocks: 1 });
    assert.equal(out.crmSchema, "pre-015");
    assert.equal(out.source.csvSha256, createHash("sha256").update(csvText).digest("hex"));
    assert.equal(out.staging.inserted, 1);
    const reports = readdirSync(join(work, "reports"));
    assert.equal(reports.length, 1);
    assert.equal((statSync(join(work, "reports", reports[0])).mode & 0o777).toString(8), "600");
    assert.match(readFileSync(join(work, "reports", reports[0]), "utf8"), /overlap_with_crm_block/, "the manual block occupies the room");
    const again = run(["--expect-leads", "1", "--expect-bookings", "1", "--expect-blocks", "1"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(JSON.parse(again.out.slice(again.out.indexOf("{"), again.out.lastIndexOf("}") + 1)).staging.inserted, 0);

    // production untouched, staging is another database whose role cannot read bb
    assert.equal(Number(await scalar("SELECT count(*)::int AS v FROM bb.slot_reservations")), 2);
    assert.equal(Number(await scalar("SELECT count(*)::int AS v FROM bb.lead_requests")), 1);
    const sp = createPool(readFileSync(join(work, "stage.url"), "utf8").trim(), { max: 1 });
    try { await assert.rejects(sp.query("SELECT 1 FROM bb.rooms"), /does not exist|permission denied/); } finally { await sp.end(); }

    // a run that aborts midway leaves the resources for the admin cleanup, which removes only ours
    const clean = sh(ADMIN, ["cleanup"]);
    assert.equal(clean.code, 0, clean.err);
    await noneOfOurs();
    await precious();
    assert.equal(existsSync(join(work, "ro.url")), false);
    assert.equal(existsSync(join(work, "stage.url")), false);
    assert.equal(existsSync(join(state, "manifest.env")), false);
    assert.equal(sh(RUN, [csv, "--expect-leads", "1", "--expect-bookings", "1"], { WORK_DIR: work }).code, 2, "no credentials: the runner refuses");

    mkdirSync(join(work, "bundle")); writeFileSync(join(work, "bundle", "x.ts"), "x");
    const wiped = sh(WIPE, [work]);
    assert.equal(wiped.code, 0, wiped.err);
    assert.equal(existsSync(work), false);
  });

  it("cleanup never drops a resource that is not the one it created (object id changed)", async () => {
    const work = newWork();
    assert.equal(sh(ADMIN, ["prepare", process.env.USER ?? "x", work]).code, 0);
    await db.pool.query("DROP DATABASE bb_sheet_staging");
    await db.pool.query("CREATE DATABASE bb_sheet_staging");
    await db.pool.query("DROP OWNED BY bb_sheets_ro; DROP ROLE bb_sheets_ro; CREATE ROLE bb_sheets_ro NOLOGIN CONNECTION LIMIT 9");
    const r = sh(ADMIN, ["cleanup"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /NOT dropping/);
    assert.ok(await exists.db("bb_sheet_staging"), "the re-created database is untouched");
    assert.equal(await scalar("SELECT rolconnlimit AS v FROM pg_roles WHERE rolname='bb_sheets_ro'"), 9, "the re-created role is untouched");
    assert.ok(existsSync(join(state, "manifest.env")), "manifest kept for manual resolution");
    assert.equal(existsSync(join(work, "ro.url")), false, "our credential files are still shredded");
    // manual resolution so later tests start clean
    await db.pool.query("DROP DATABASE bb_sheet_staging");
    await db.pool.query("DROP ROLE bb_sheets_ro; DROP ROLE bb_sheets_stage");
    rmSync(join(state, "manifest.env"));
  });

  it("wipe refuses a directory without the marker and keeps unknown files", async () => {
    const plain = join(home, "plain"); mkdirSync(plain); writeFileSync(join(plain, "keep.csv"), "x");
    const r = sh(WIPE, [plain]);
    assert.notEqual(r.code, 0);
    assert.ok(existsSync(join(plain, "keep.csv")));
    const work = newWork();
    writeFileSync(join(work, "a.csv"), "x"); writeFileSync(join(work, "precious.txt"), "keep me");
    const w = sh(WIPE, [work]);
    assert.notEqual(w.code, 0);
    assert.ok(existsSync(join(work, "precious.txt")), "unknown file is never deleted");
    assert.equal(existsSync(join(work, "a.csv")), false);
  });
});

describe("sheets-verify-archive.sh", { skip: spawnSync("python3", ["--version"]).status === 0 ? false : "python3 missing" }, () => {
  let root: string;
  before(() => { root = mkdtempSync(join(tmpdir(), "bbverify-")); });
  after(() => rmSync(root, { recursive: true, force: true }));
  const make = (name: string, entries: Array<[string, string, string?]>) => {
    const file = join(root, `${name}.tgz`);
    const py = `import tarfile,io,sys,json\nt=tarfile.open(sys.argv[1],'w:gz')\nfor kind,path,extra in json.loads(sys.argv[2]):\n  i=tarfile.TarInfo(path)\n  if kind=='f':\n    d=b'x'; i.size=len(d); t.addfile(i,io.BytesIO(d))\n  elif kind=='d': i.type=tarfile.DIRTYPE; i.mode=0o755; t.addfile(i)\n  elif kind=='l': i.type=tarfile.SYMTYPE; i.linkname=extra; t.addfile(i)\n  elif kind=='h': i.type=tarfile.LNKTYPE; i.linkname=extra; t.addfile(i)\nt.close()\n`;
    assert.equal(spawnSync("python3", ["-I", "-c", py, file, JSON.stringify(entries.map((e) => [e[0], e[1], e[2] ?? ""]))]).status, 0);
    return file;
  };
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const attempt = (archive: string, want: string) => {
    const cwd = mkdtempSync(join(root, "wd-")); chmodSync(cwd, 0o700);
    const r = spawnSync("bash", [VERIFY, archive, want], { cwd, encoding: "utf8" });
    return { code: r.status, all: r.stdout + r.stderr, cwd, extracted: existsSync(join(cwd, "bundle")) };
  };
  const GOOD: Array<[string, string, string?]> = [["d", "bundle/"], ["f", "bundle/package.json"], ["d", "bundle/scripts/"], ["f", "bundle/scripts/a.sh"], ["d", "bundle/src/core/"], ["f", "bundle/src/core/a.ts"], ["d", "bundle/node_modules/"], ["f", "bundle/node_modules/p/i..js"]];

  it("accepts the expected tree with the right SHA-256, lists names, extracts", () => {
    const f = make("good", GOOD);
    const r = attempt(f, sha(f));
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /archive OK/);
    assert.match(r.all, /bundle\/scripts\/a\.sh/);
    assert.ok(r.extracted);
    assert.ok(existsSync(join(r.cwd, ".bb-sheets-workdir")));
    // a second extraction into the same directory is refused (never overwrites)
    const again = spawnSync("bash", [VERIFY, f, sha(f)], { cwd: r.cwd, encoding: "utf8" });
    assert.notEqual(again.status, 0);
  });
  it("rejects a wrong checksum before extracting anything", () => {
    const f = make("sum", GOOD);
    const r = attempt(f, "0".repeat(64));
    assert.notEqual(r.code, 0);
    assert.match(r.all, /mismatch/);
    assert.equal(r.extracted, false);
  });
  for (const [label, bad] of [
    ["an absolute path", ["f", "/tmp/evil"]], ["a parent-directory path", ["f", "bundle/../evil"]], ["an unexpected top-level entry", ["f", "other/file"]],
    ["a symlink", ["l", "bundle/scripts/link", "/etc/passwd"]], ["a hardlink", ["h", "bundle/scripts/hl", "bundle/scripts/a.sh"]], ["an entry outside the allowed subtrees", ["f", "bundle/evil.sh"]],
  ] as const) {
    it(`rejects ${label}`, () => {
      const f = make(label.replace(/\W/g, "_"), [...GOOD, [bad[0], bad[1], bad[2]] as [string, string, string?]]);
      const r = attempt(f, sha(f));
      assert.notEqual(r.code, 0, r.all);
      assert.equal(r.extracted, false);
    });
  }
  it("refuses a directory that is not private (mode 700)", () => {
    const f = make("mode", GOOD);
    const cwd = mkdtempSync(join(root, "open-")); chmodSync(cwd, 0o755);
    const r = spawnSync("bash", [VERIFY, f, sha(f)], { cwd, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(cwd, "bundle")), false);
  });
});
