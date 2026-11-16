import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { almatyToday } from "../src/core/dates.ts";
import {
  ensureStaging, googleSheetsClient, parseCsv, readCsv, loadCatalog, loadCrmSnapshot, normalizeRow, readSheet, reconcile, stageRows, summarize,
  type CrmSnapshot, type RawRow, type SheetsClient,
} from "../src/core/sheets-import/index.ts";
import { seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

const SID = "sheet-test-id";
const CATALOG = { rooms: [{ id: "room-a", name: "Космос" }, { id: "room-b", name: "Джунгли" }], packages: [{ id: "pkg-1", name: "Стандарт" }] };
const EMPTY_CRM: CrmSnapshot = { leads: [], reservations: [] };
const TODAY = "2026-11-16";
const HEADER = ["Дата", "Время", "Пакет", "Аниматор", "Комната", "Клиент", "Телефон", "Ребенок", "Возраст", "Предоплата", "Количество детей", "Количество взрослых"];

function raw(over: Partial<RawRow> = {}): RawRow {
  return { date: "20.11.2026", time: "14:00", package: "Стандарт", animator: "Аня", room: "Космос", client: "Тест Клиент", phone: "8 707 111 22 33", child: "Тест Ребёнок", age: "7", prepayment: "20 000", children: "10", adults: "5", ...over };
}
const run = (rows: RawRow[], crm = EMPTY_CRM) => reconcile(rows.map((r, i) => normalizeRow(r, { spreadsheetId: SID, sheetId: 1, rowNumber: i + 2 }, CATALOG)), crm, TODAY);

describe("sheets import: normalisation", () => {
  it("accepts any valid start minute exactly as written: 13:15, 13:30, 13:45, 14:30, 16:40, 17:30", () => {
    for (const t of ["13:00", "13:15", "13:30", "13:45", "14:30", "16:40", "17:30"]) {
      const [r] = run([raw({ time: t })]);
      assert.equal(r.time, t);
      assert.ok(!r.reasons.some((x) => (x as string).includes("whole_hour")));
      assert.equal(r.status, "CANDIDATE", `${t} must not be pushed to review because of its minutes`);
    }
  });
  it("still rejects impossible times", () => {
    for (const t of ["25:00", "13:60", "abc", ""]) assert.equal(run([raw({ time: t })])[0].status, "NEEDS_REVIEW");
  });
  it("does not shift the clock: venue wall-clock semantics are recorded as an unconfirmed assumption", () => {
    const [r] = run([raw({ time: "10:00" })]);
    assert.equal(r.time, "10:00");
    assert.ok(r.reasons.includes("time_semantics_unconfirmed"));
  });
  it("a clean future row is only a CANDIDATE, with the prepayment as an unverified candidate", () => {
    const [r] = run([raw()]);
    assert.equal(r.status, "CANDIDATE");
    assert.equal(r.prepaymentCandidateKzt, 20000);
    assert.ok(r.reasons.includes("prepayment_unverified") && r.reasons.includes("no_confirmation_flag"));
    assert.equal(r.phoneE164, "+77071112233");
  });
  it("flags missing prepayment, unknown and ambiguous rooms, bad dates and bad phones", () => {
    const rows = run([
      raw({ prepayment: "", date: "21.11.2026", room: "Джунгли" }),
      raw({ room: "Неизвестная", date: "22.11.2026" }),
      raw({ room: "а", date: "23.11.2026" }),
      raw({ date: "31.02.2026" }),
      raw({ phone: "123", date: "24.11.2026" }),
      raw({ prepayment: "внесена", date: "25.11.2026" }),
    ]);
    assert.ok(rows[0].reasons.includes("no_prepayment") && rows[0].status === "CANDIDATE");
    assert.ok(rows[1].reasons.includes("room_unknown"));
    assert.ok(rows[2].reasons.includes("room_ambiguous") || rows[2].reasons.includes("room_unknown"));
    assert.ok(rows[3].reasons.includes("date_unparseable"));
    assert.ok(rows[4].reasons.includes("phone_invalid"));
    assert.ok(rows[5].reasons.includes("prepayment_unparseable") && rows[5].status === "NEEDS_REVIEW");
  });
  it("past events are archive-only, never bookings", () => {
    const [r] = run([raw({ date: "01.10.2026" })]);
    assert.equal(r.status, "ARCHIVE_ONLY");
  });
  it("source identity ignores the row number and the volatile fields, the fingerprint tracks edits", () => {
    const a = normalizeRow(raw(), { spreadsheetId: SID, sheetId: 1, rowNumber: 5 }, CATALOG);
    const moved = normalizeRow(raw(), { spreadsheetId: SID, sheetId: 1, rowNumber: 99 }, CATALOG);
    const edited = normalizeRow(raw({ prepayment: "30 000" }), { spreadsheetId: SID, sheetId: 1, rowNumber: 5 }, CATALOG);
    assert.equal(a.sourceKey, moved.sourceKey);
    assert.equal(a.fingerprint, moved.fingerprint);
    assert.equal(a.sourceKey, edited.sourceKey);
    assert.notEqual(a.fingerprint, edited.fingerprint);
  });
});

describe("sheets import: reconciliation", () => {
  it("detects exact duplicates and room/time overlaps inside the sheet", () => {
    const dup = run([raw(), raw()]);
    assert.ok(dup.every((r) => r.reasons.includes("duplicate_in_sheet") && r.status === "NEEDS_REVIEW"));
    assert.notEqual(dup[0].sourceKey, dup[1].sourceKey);
    const ov = run([raw({ time: "14:00" }), raw({ time: "16:00", phone: "8 707 999 88 77", client: "Другой" })]);
    assert.ok(ov.every((r) => r.reasons.includes("overlap_in_sheet")));
    const ok = run([raw({ time: "10:00" }), raw({ time: "14:00", phone: "8 707 999 88 77", client: "Другой" })]);
    assert.ok(ok.every((r) => !r.reasons.includes("overlap_in_sheet")), "back-to-back four-hour events do not overlap");
  });
  it("adjacent bookings to the minute are allowed, one minute of overlap is not", () => {
    const other = { phone: "8 707 999 88 77", client: "Другой" };
    const adj = run([raw({ time: "13:15" }), raw({ time: "17:15", ...other })]);
    assert.ok(adj.every((r) => r.status === "CANDIDATE"));
    const ov = run([raw({ time: "13:15" }), raw({ time: "17:14", ...other })]);
    assert.ok(ov.every((r) => r.reasons.includes("overlap_in_sheet") && r.status === "NEEDS_REVIEW"));
    const night = run([raw({ time: "13:30" }), raw({ time: "16:40", ...other })]);
    assert.ok(night.every((r) => r.reasons.includes("overlap_in_sheet")));
    const otherRoom = run([raw({ time: "13:30" }), raw({ time: "16:40", room: "Джунгли", ...other })]);
    assert.ok(otherRoom.every((r) => r.status === "CANDIDATE"), "different rooms never conflict");
  });
  it("checks branch working hours only when they are given; the four-hour window must fit", () => {
    const hours = { workingHours: { openMin: 10 * 60, closeMin: 23 * 60 } };
    const rows = [raw({ time: "19:30" }), raw({ time: "19:00", room: "Джунгли", phone: "8 707 999 88 77", client: "Другой" }), raw({ time: "09:45", room: "Джунгли", phone: "8 707 999 88 66", client: "Третий" })]
      .map((r, i) => normalizeRow(r, { spreadsheetId: SID, sheetId: 1, rowNumber: i + 2 }, CATALOG));
    reconcile(rows, EMPTY_CRM, TODAY, hours);
    assert.deepEqual(rows.map((r) => r.reasons.includes("outside_working_hours")), [true, false, true]);
    assert.equal(run([raw({ time: "19:30" })])[0].status, "CANDIDATE", "no hours given: not checked");
  });
  it("matches existing CRM records and reports conflicts instead of overwriting", () => {
    const crm: CrmSnapshot = {
      leads: [{ id: "l1", date: "2026-11-20", phoneE164: "+77071112233", nameKey: "тест клиент", children: 10, packageId: "pkg-1", roomId: null, status: "new" }],
      reservations: [],
    };
    assert.equal(run([raw()], crm)[0].status, "ALREADY_IN_CRM");
    assert.equal(run([raw({ children: "12" })], crm)[0].status, "NEEDS_REVIEW");
    const other = run([raw({ client: "Иной Человек" })], crm)[0];
    assert.equal(other.status, "CANDIDATE", "same phone but another person is not a match");
  });
  it("flags overlap with a CRM reservation", () => {
    const crm: CrmSnapshot = { leads: [], reservations: [{ id: "r1", date: "2026-11-20", startTime: "12:00", roomId: "room-a", phoneE164: "+77070000000", children: null, packageId: null }] };
    assert.ok(run([raw({ time: "14:00" })], crm)[0].reasons.includes("overlap_with_crm"));
  });
  it("summary contains aggregates only", () => {
    const s = summarize(run([raw(), raw({ date: "01.10.2026", phone: "8 707 555 44 33" })]), TODAY);
    assert.equal(s.total, 2);
    assert.equal(s.future, 1);
    assert.ok(!JSON.stringify(s).includes("707"));
  });
});

describe("sheets import: reader", () => {
  const sheetRows = [["Банкеты"], HEADER, ["20.11.2026", "14:00", "Стандарт", "", "Космос", "К", "8 707 111 22 33", "Р", "7", "20000", "10", "5"], [], ["", "", "", "", "", "", "", "", "", "", "", ""],
    ["21.11.2026", "10:00", "Стандарт", "", "Джунгли", "К2", "8 707 111 22 44", "", "", "", "", ""]];
  const fake: SheetsClient = {
    getMeta: async () => ({ timeZone: "Europe/Moscow", sheets: [{ sheetId: 77, title: "Лист 1", rowCount: 1000 }] }),
    getValues: async () => sheetRows,
  };
  it("reads the whole used range, finds the header below a title row and skips blank rows", async () => {
    const r = await readSheet(fake, SID);
    assert.equal(r.rows.length, 2);
    assert.equal(r.blankRows, 2);
    assert.equal(r.sheetId, 77);
    assert.equal(r.rows[1].source.rowNumber, 6);
    assert.equal(r.spreadsheetTimeZone, "Europe/Moscow");
  });
  it("CSV goes through the same normalizer and reconciliation as the API and yields identical keys", async () => {
    const csv = "\uFEFF" + [HEADER.join(";"), "20.11.2026;13:15;Стандарт;;Космос;\"К, Клиент\";8 707 111 22 33;Р;7;20000;10;5", ";;;;;;;;;;;", "21.11.2026;16:40;Стандарт;;Джунгли;К2;8 707 111 22 44;;;;;"].join("\r\n");
    const c = readCsv(csv, { spreadsheetId: SID, sheetId: 77 });
    assert.equal(c.rows.length, 2);
    assert.equal(c.blankRows, 1);
    const viaCsv = reconcile(c.rows.map((r) => normalizeRow(r.raw, r.source, CATALOG)), EMPTY_CRM, TODAY);
    assert.deepEqual(viaCsv.map((r) => r.time), ["13:15", "16:40"]);
    assert.ok(viaCsv.every((r) => r.status === "CANDIDATE"));
    assert.equal(viaCsv[0].customerName, "К, Клиент");
    const api = await readSheet({ getMeta: async () => ({ timeZone: "Europe/Moscow", sheets: [{ sheetId: 77, title: "x", rowCount: 9 }] }), getValues: async () => parseCsv(csv) }, SID);
    const viaApi = reconcile(api.rows.map((r) => normalizeRow(r.raw, r.source, CATALOG)), EMPTY_CRM, TODAY);
    assert.deepEqual(viaApi.map((r) => [r.sourceKey, r.fingerprint]), viaCsv.map((r) => [r.sourceKey, r.fingerprint]));
  });
  it("a CSV without the header fails without echoing any cell", () => {
    assert.throws(() => readCsv("secret,+77070000000\nx,y", { spreadsheetId: SID, sheetId: 1 }), (e: Error) => e.message === "header_not_found");
  });
  it("uses the read-only scope, sends only a bearer token and never writes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? String(init.body) : undefined });
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      return new Response(JSON.stringify({ values: [["x"]] }));
    }) as typeof fetch;
    const c = googleSheetsClient({ client_email: "sa@example.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, f);
    await c.getValues(SID, "'A'");
    assert.ok(calls.every((x) => x.method === "GET" || x.url.includes("oauth2")));
    const assertion = new URLSearchParams(calls[0].body).get("assertion")!;
    assert.ok(Buffer.from(assertion.split(".")[1], "base64url").toString().includes("spreadsheets.readonly"));
    assert.ok(!Buffer.from(assertion.split(".")[1], "base64url").toString().includes("auth/spreadsheets\""));
  });
  it("explains a missing share instead of failing silently", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const f = (async (url: string | URL | Request) => (String(url).includes("oauth2") ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })) : new Response("", { status: 403 }))) as typeof fetch;
    const c = googleSheetsClient({ client_email: "sa@example.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, f);
    await assert.rejects(c.getMeta(SID), /sheets_access_denied/);
  });
});

describe("sheets import: staging against a real PostgreSQL", () => {
  let db: TestDb;
  before(async () => { db = await startTestDb(); await seedFromSite(db.pool); });
  after(async () => { await db.stop(); });

  it("is idempotent: a second run changes nothing, a moved row only updates its row number, an edit updates in place, a vanished row is marked", async () => {
    await ensureStaging(db.pool);
    const catalog = await loadCatalog(db.pool);
    const roomName = catalog.rooms[0].name, pkgName = catalog.packages[0].name;
    const mk = (over: Partial<RawRow>, rowNumber: number) => normalizeRow(raw({ room: roomName, package: pkgName, ...over }), { spreadsheetId: SID, sheetId: 1, rowNumber }, catalog);
    const crm = await loadCrmSnapshot(db.pool);
    const batch = (rows: ReturnType<typeof mk>[]) => reconcile(rows, crm, TODAY);
    const a = (n = 2) => mk({ date: "20.11.2026", time: "13:15" }, n);
    const b = (n = 3, pre = "5 000") => mk({ date: "21.11.2026", time: "16:40", phone: "8 707 222 33 44", client: "Второй", prepayment: pre }, n);

    const first = await stageRows(db.pool, SID, batch([a(), b()]));
    assert.deepEqual([first.inserted, first.updated, first.unchanged], [2, 0, 0]);
    const second = await stageRows(db.pool, SID, batch([a(), b()]));
    assert.deepEqual([second.inserted, second.updated, second.unchanged], [0, 0, 2]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM sheet_import.rows")).rows[0].n, 2);

    const moved = await stageRows(db.pool, SID, batch([a(40), b(41)]));
    assert.equal(moved.movedRows, 2);
    assert.equal(moved.inserted, 0);

    const edited = await stageRows(db.pool, SID, batch([a(40), b(41, "9 000")]));
    assert.equal(edited.updated, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM sheet_import.rows")).rows[0].n, 2);

    const gone = await stageRows(db.pool, SID, batch([a(40)]));
    assert.equal(gone.disappeared, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM sheet_import.rows WHERE missing_since IS NOT NULL")).rows[0].n, 1);
  });

  it("never writes to bb: no reservation, payment or lead appears", async () => {
    const n = async (t: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM bb.${t}`)).rows[0].n;
    const before = [await n("slot_reservations"), await n("lead_requests"), await n("contacts")];
    const catalog = await loadCatalog(db.pool);
    const rows = reconcile([normalizeRow(raw({ room: catalog.rooms[0].name, package: catalog.packages[0].name, date: "25.11.2026" }), { spreadsheetId: SID, sheetId: 1, rowNumber: 9 }, catalog)], await loadCrmSnapshot(db.pool), almatyToday());
    await stageRows(db.pool, SID, rows);
    assert.deepEqual([await n("slot_reservations"), await n("lead_requests"), await n("contacts")], before);
  });

  it("the read-only snapshot transaction cannot write", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      await loadCrmSnapshot(c);
      await assert.rejects(c.query("INSERT INTO bb.rooms (id, name) VALUES ('zz','zz')"), /read-only/);
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
});
