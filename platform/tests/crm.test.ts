import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getContact, listContacts } from "../src/core/crm.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ConsentUnavailableError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { exportContacts, guardCell } from "../src/core/export.ts";
import { submitConsent, submitLead } from "../src/core/intake.ts";
import { approveDocument, createDraft, publishDocument, updateDraft } from "../src/core/legal.ts";
import { drainOutbox, outboxStats } from "../src/core/outbox.ts";
import { sendTelegram, telegramConfigFromEnv } from "../src/core/telegram.ts";
import { setCanExport } from "../src/core/users.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

const FUTURE = (() => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
})();

describe("CRM: intake, outbox, Telegram, export", () => {
  let db: TestDb;
  let tg: Server;
  const messages: string[] = [];
  let telegramUp = true;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  const config = () => telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "1", TELEGRAM_API_BASE: `http://127.0.0.1:${(tg.address() as { port: number }).port}` });
  const send = (text: string) => sendTelegram(config(), text, 2000);
  const lead = (over: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), name: "Айгерим Тест", phone: "8 (747) 111-22-33", date: FUTURE, children: 8, consent: true as const, ...over });

  before(async () => {
    tg = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!telegramUp) {
          res.writeHead(500, { "content-type": "application/json" }).end('{"ok":false}');
          return;
        }
        messages.push(JSON.parse(body).text);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
    db = await startTestDb();
    await seedFromSite(db.pool);
    owner = await makeUser(db.pool, "owner");
  });
  after(async () => {
    tg.close();
    await db.stop();
  });

  async function publishAll() {
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
  }

  it("refuses to collect personal data while the consent text is not published", async () => {
    await assert.rejects(() => submitLead(db.pool, lead()), ConsentUnavailableError);
    await assert.rejects(() => submitConsent(db.pool, { idempotencyKey: randomUUID(), name: "А", phone: "+77471112233", acceptRules: true, acceptPersonalData: true }), ConsentUnavailableError);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.contacts")).rows[0].n, 0);
  });

  it("a document with placeholders can never be approved or published", async () => {
    const d = await createDraft(db.pool, owner, { kind: "privacy_policy", title: "Политика", body: "ТОО [ТРЕБУЕТСЯ: название], БИН [ТРЕБУЕТСЯ]" });
    await assert.rejects(() => approveDocument(db.pool, owner, d.id), ValidationError);
    await assert.rejects(() => publishDocument(db.pool, owner, d.id));
    await updateDraft(db.pool, owner, d.id, { title: "Политика", body: "Готовый текст" });
    await approveDocument(db.pool, owner, d.id);
  });

  it("lead lands in CRM, outbox, consent history and Telegram", async () => {
    await publishAll();
    const input = lead();
    const r = await submitLead(db.pool, input, { ip: "203.0.113.5", userAgent: "t", ipPepper: "pepper" });
    assert.equal(r.duplicate, false);
    const sent = await drainOutbox(db.pool, { send, level: "full", onlyRefId: r.leadId });
    assert.equal(sent.sent, 1);
    assert.match(messages.at(-1)!, /Айгерим Тест/);
    assert.match(messages.at(-1)!, /\+7 747 111 22 33/);
    const ce = (await db.pool.query("SELECT d.kind::text kind, d.version, e.ip_hash FROM bb.consent_events e JOIN bb.legal_documents d ON d.id=e.document_id WHERE e.lead_request_id=$1", [r.leadId])).rows;
    assert.equal(ce.length, 1);
    assert.equal(ce[0].kind, "personal_data_consent");
    assert.ok(ce[0].ip_hash && !ce[0].ip_hash.includes("203.0.113.5"));
    const stored = (await db.pool.query("SELECT payload::text FROM (SELECT to_jsonb(o) payload FROM bb.outbox o) x")).rows.map((x) => x.payload).join();
    assert.ok(!stored.includes("Айгерим") && !stored.includes("7471112233"), "outbox holds a reference only");
  });

  it("Telegram down: lead is saved, retried, delivered exactly once after recovery", async () => {
    telegramUp = false;
    const before = messages.length;
    const r = await submitLead(db.pool, lead({ name: "Данияр Резерв" }));
    const failed = await drainOutbox(db.pool, { send, level: "full", onlyRefId: r.leadId });
    assert.deepEqual(failed, { sent: 0, retry: 1, dead: 0 });
    assert.equal((await db.pool.query("SELECT 1 FROM bb.lead_requests WHERE id=$1", [r.leadId])).rowCount, 1);
    const row = (await db.pool.query("SELECT status, last_error_code FROM bb.outbox WHERE ref_id=$1", [r.leadId])).rows[0];
    assert.equal(row.status, "pending");
    assert.equal(row.last_error_code, "rejected");
    // not due yet: nothing is sent early
    assert.equal((await drainOutbox(db.pool, { send, level: "full" })).sent, 0);
    telegramUp = true;
    await db.pool.query("UPDATE bb.outbox SET next_attempt_at = now() WHERE ref_id=$1", [r.leadId]);
    assert.equal((await drainOutbox(db.pool, { send, level: "full" })).sent, 1);
    assert.equal((await drainOutbox(db.pool, { send, level: "full" })).sent, 0);
    assert.equal(messages.length - before, 1);
    assert.ok(!JSON.stringify(row).includes("TESTTOKEN"));
  });

  it("a notification becomes dead after the maximum attempts and is visible in stats", async () => {
    telegramUp = false;
    const r = await submitLead(db.pool, lead({ name: "Мёртвая Заявка" }));
    await db.pool.query("UPDATE bb.outbox SET attempts = 8 WHERE ref_id=$1", [r.leadId]);
    assert.equal((await drainOutbox(db.pool, { send, level: "full", onlyRefId: r.leadId })).dead, 1);
    telegramUp = true;
    assert.equal((await outboxStats(db.pool)).dead, 1);
  });

  it("repeated and parallel submits with one key create a single lead and a single message", async () => {
    const input = lead({ name: "Параллель Тест", phone: "+77079998877" });
    const before = messages.length;
    const pools = [db.newPool(3), db.newPool(3), db.newPool(3), db.newPool(3)];
    const results = await Promise.all(pools.map((p) => submitLead(p, input)));
    assert.equal(new Set(results.map((r) => r.leadId)).size, 1);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal((await submitLead(db.pool, input)).duplicate, true);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.lead_requests WHERE idempotency_key=$1", [input.idempotencyKey])).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.consent_events WHERE lead_request_id=$1", [results[0].leadId])).rows[0].n, 1);
    // two workers draining at once still send one message
    const drains = await Promise.all(pools.map((p) => drainOutbox(p, { send, level: "full", onlyRefId: results[0].leadId })));
    assert.equal(drains.reduce((s, d) => s + d.sent, 0), 1);
    assert.equal(messages.length - before, 1);
  });

  it("invalid input is rejected without writing anything", async () => {
    const n = () => db.pool.query("SELECT (SELECT count(*) FROM bb.contacts) + (SELECT count(*) FROM bb.lead_requests) AS n").then((r) => Number(r.rows[0].n));
    const base = await n();
    await assert.rejects(() => submitLead(db.pool, lead({ phone: "123" })), ValidationError);
    await assert.rejects(() => submitLead(db.pool, lead({ date: "2000-01-01" })), ValidationError);
    await assert.rejects(() => submitLead(db.pool, lead({ name: "" })), ValidationError);
    await assert.rejects(() => submitLead(db.pool, lead({ consent: false as never })), ValidationError);
    await assert.rejects(() => submitLead(db.pool, lead({ packageId: "nope" })), ValidationError);
    assert.equal(await n(), base);
  });

  it("QR registration creates a contact and one consent event per document version, and is idempotent", async () => {
    const input = { idempotencyKey: randomUUID(), name: "Сауле Гость", phone: "+7 701 555 44 33", acceptRules: true as const, acceptPersonalData: true as const };
    const r = await submitConsent(db.pool, input, { ip: "198.51.100.1", ipPepper: "p" });
    assert.deepEqual(r.documents.map((d) => d.kind).sort(), ["companion_duties", "personal_data_consent", "visit_rules"]);
    assert.ok(r.documents.every((d) => d.version >= 1));
    assert.equal((await submitConsent(db.pool, input)).duplicate, true);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.consent_events WHERE registration_id=$1", [r.registrationId])).rows[0].n, 3);
    await assert.rejects(() => submitConsent(db.pool, { ...input, idempotencyKey: randomUUID(), acceptPersonalData: false as never }), ValidationError);
    const c = (await db.pool.query("SELECT source, phone_verification, marketing_opt_in FROM bb.contacts WHERE phone_e164='+77015554433'")).rows[0];
    assert.deepEqual(c, { source: "qr", phone_verification: "unverified", marketing_opt_in: false });
  });

  it("same person across QR and lead is one contact with two events; same phone, other name stays separate", async () => {
    const phone = "+77025551100";
    await submitConsent(db.pool, { idempotencyKey: randomUUID(), name: "Марат  Иванов", phone, acceptRules: true, acceptPersonalData: true });
    await submitLead(db.pool, lead({ name: "марат иванов", phone: "8 702 555 11 00" }));
    await submitLead(db.pool, lead({ name: "Ольга Другая", phone }));
    const list = await listContacts(db.pool, owner, { q: "5551100" });
    assert.equal(list.total, 2);
    const marat = list.rows.find((r) => r.name.toLowerCase().includes("марат"))!;
    assert.equal(marat.leadsCount, 1);
    assert.equal(marat.registrationsCount, 1);
    assert.equal(marat.samePhoneOthers, 1);
    const card = await getContact(db.pool, owner, marat.id);
    assert.equal(card!.samePhone.length, 1);
    assert.ok(card!.consents.length >= 4);
    const bySource = await listContacts(db.pool, owner, { source: "qr" });
    assert.ok(bySource.rows.every((r) => r.source === "qr"));
  });

  describe("export", () => {
    const meta = { ip: "192.0.2.1" };
    it("allows the owner and a manager the owner permitted; blocks everyone else without logging", async () => {
      const manager = await makeUser(db.pool, "manager");
      const editor = await makeUser(db.pool, "editor");
      const logCount = async () => (await db.pool.query("SELECT count(*)::int n FROM bb.export_log")).rows[0].n;
      const base = await logCount();
      await assert.rejects(() => exportContacts(db.pool, manager, { format: "csv" }), ForbiddenError);
      await assert.rejects(() => exportContacts(db.pool, editor, { format: "csv" }), ForbiddenError);
      await assert.rejects(() => exportContacts(db.pool, { id: editor.id, role: "editor", canExport: true }, { format: "csv" }), ForbiddenError);
      assert.equal(await logCount(), base);

      await assert.rejects(() => setCanExport(db.pool, manager, manager.id, true), ForbiddenError); // only the owner grants
      await setCanExport(db.pool, owner, manager.id, true);
      const res = await exportContacts(db.pool, { id: manager.id, role: "manager", canExport: true }, { format: "csv" }, meta);
      assert.ok(res.rowCount > 0);
      assert.equal(await logCount(), base + 1);
      const own = await exportContacts(db.pool, owner, { format: "xlsx", columns: ["name", "phone"] }, meta);
      assert.equal(await logCount(), base + 2);
      assert.ok(own.body.subarray(0, 2).toString() === "PK");
      const log = (await db.pool.query("SELECT format, row_count, columns, ip FROM bb.export_log ORDER BY id DESC LIMIT 1")).rows[0];
      assert.deepEqual(log.columns, ["name", "phone"]);
      assert.equal(log.ip, "192.0.2.1");
    });

    it("validates columns, formats and date range", async () => {
      await assert.rejects(() => exportContacts(db.pool, owner, { format: "csv", columns: ["name", "1; DROP TABLE x"] }), ValidationError);
      await assert.rejects(() => exportContacts(db.pool, owner, { format: "pdf" as never }), ValidationError);
      await assert.rejects(() => exportContacts(db.pool, owner, { format: "csv", from: "2026-02-30" }), ValidationError);
      await assert.rejects(() => exportContacts(db.pool, owner, { format: "csv", from: "2026-05-02", to: "2026-05-01" }), ValidationError);
      const empty = await exportContacts(db.pool, owner, { format: "csv", from: "2001-01-01", to: "2001-01-02" });
      assert.equal(empty.rowCount, 0);
    });

    it("phone numbers keep their +7 and stay TEXT in XLSX (never a number or a formula); CSV keeps the plain value", async () => {
      await submitConsent(db.pool, { idempotencyKey: randomUUID(), name: "+7 Имя с плюсом", phone: "+7 701 000 00 02", acceptRules: true, acceptPersonalData: true });
      const x = await exportContacts(db.pool, owner, { format: "xlsx", columns: ["name", "phone"], filters: { q: "00 00 02".replace(/ /g, "") } });
      const dir = mkdtempSync(join(tmpdir(), "bbx-"));
      try {
        writeFileSync(join(dir, "p.xlsx"), x.body);
        const sheet = execFileSync("unzip", ["-p", join(dir, "p.xlsx"), "xl/worksheets/sheet1.xml"]).toString();
        const strings = execFileSync("unzip", ["-p", join(dir, "p.xlsx"), "xl/sharedStrings.xml"]).toString();
        assert.ok(strings.includes("+77010000002"), "phone is stored as a string with its +");
        assert.ok(strings.includes("&apos;+7 Имя с плюсом") || strings.includes("'+7 Имя с плюсом"), "a NAME that starts with + is neutralised");
        const dataCells = [...sheet.matchAll(/<c [^>]*>/g)].map((m) => m[0]);
        assert.ok(dataCells.length > 0 && dataCells.every((c) => /t="(s|inlineStr)"/.test(c)), "every cell is text, none numeric");
        assert.ok(!sheet.includes("<f"), "no formulas");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const csv = (await exportContacts(db.pool, owner, { format: "csv", columns: ["name", "phone"], filters: { q: "00 00 02".replace(/ /g, "") } })).body.toString("utf8");
      assert.match(csv, /\+77010000002\r\n/);
      assert.match(csv, /'\+7 Имя с плюсом/);
    });

    it("neutralises formula injection in CSV and XLSX", async () => {
      assert.equal(guardCell("=1+1"), "'=1+1");
      assert.equal(guardCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
      assert.equal(guardCell("-2+3"), "'-2+3");
      assert.equal(guardCell("@SUM(A1)"), "'@SUM(A1)");
      assert.equal(guardCell("\t=1"), "'\t=1");
      assert.equal(guardCell("+77471112233"), "+77471112233");
      assert.equal(guardCell("Обычное имя"), "Обычное имя");
      await submitConsent(db.pool, { idempotencyKey: randomUUID(), name: '=HYPERLINK("http://evil","x")', phone: "+77010000001", acceptRules: true, acceptPersonalData: true });
      const csv = await exportContacts(db.pool, owner, { format: "csv", columns: ["name", "phone"], filters: { q: "HYPERLINK" } });
      const text = csv.body.toString("utf8");
      assert.ok(text.startsWith("﻿"));
      assert.match(text, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
      assert.match(text, /\+77010000001/);
      const x = await exportContacts(db.pool, owner, { format: "xlsx", columns: ["name"], filters: { q: "HYPERLINK" } });
      const dir = mkdtempSync(join(tmpdir(), "bbx-"));
      try {
        writeFileSync(join(dir, "a.xlsx"), x.body);
        const sheet = execFileSync("unzip", ["-p", join(dir, "a.xlsx"), "xl/worksheets/sheet1.xml"]).toString();
        assert.ok(!sheet.includes("<f>") && !sheet.includes("<f "), "no formula element");
        const strings = execFileSync("unzip", ["-p", join(dir, "a.xlsx"), "xl/sharedStrings.xml"]).toString();
        assert.ok(strings.includes("&apos;=HYPERLINK") || strings.includes("'=HYPERLINK"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
