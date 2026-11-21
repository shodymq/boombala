import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { submitLead } from "../src/core/intake.ts";
import { drainOutbox } from "../src/core/outbox.ts";
import { sendTelegram, type TelegramConfig } from "../src/core/telegram.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

/**
 * The notification chain of an enquiry: website -> API -> CRM (outbox row, in the same transaction) -> worker -> Telegram -> manager.
 * The Telegram API is replaced by a LOCAL mock on 127.0.0.1 (a real bot token and a real chat are never used here). Only the Telegram
 * request path is mocked; the outbox worker, the message builder and the HTTP client are the production code.
 */

describe("Telegram delivery of enquiries (the outbox worker, the message and the failure modes)", () => {
  let db: TestDb;
  let server: Server;
  let base: string;
  let config: TelegramConfig;
  let mode: "ok" | "down" | "rejected" = "ok";
  const received: string[] = [];
  let owner: Awaited<ReturnType<typeof makeUser>>;
  const outboxRow = async (leadId: string) => (await db.pool.query("SELECT id, status, attempts, last_error_code FROM bb.outbox WHERE ref_id = $1 AND topic = 'telegram.lead'", [leadId])).rows[0];
  const drain = (leadId?: string) => drainOutbox(db.pool, { level: "full", send: (text) => sendTelegram(config, text, 3000), onlyRefId: leadId, limit: 20 });
  const enquiry = (over: Record<string, unknown>) => ({ idempotencyKey: randomUUID(), name: "Айгерим Тестова", phone: "+77011112233", date: "2099-03-04", children: 7, consent: true as const, ...over }) as Parameters<typeof submitLead>[1];

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    await db.pool.query("INSERT INTO bb.legal_documents (kind, version, title, body, status, published_at) VALUES ('personal_data_consent', 1, 'Согласие', 'Текст.', 'published', now())");
    owner = await makeUser(db.pool, "owner", "telegram.owner@example.test");
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "down") {
          res.writeHead(503).end();
          return;
        }
        if (mode === "rejected") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, description: "chat not found" }));
          return;
        }
        received.push(JSON.parse(body).text);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: { message_id: received.length } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config = { token: "123456:TEST-ONLY-TOKEN-0000000000000000", chatId: "-1000000000", apiBase: base };
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.stop();
  });

  it("an enquiry is written to the CRM and its notification is queued in the SAME transaction (no lost enquiry)", async () => {
    const r = await submitLead(db.pool, enquiry({ packageId: "star-party", roomId: "ice-room", slotId: 2 }));
    const row = await outboxRow(r.leadId);
    assert.ok(row, "an outbox task exists");
    assert.equal(row.status, "pending");
  });

  it("Star Party: the manager receives the full package name, date, room, children and the time slot", async () => {
    received.length = 0;
    mode = "ok";
    const r = await submitLead(db.pool, enquiry({ packageId: "star-party", roomId: "ice-room", slotId: 2, phone: "+77011112201" }));
    const res = await drain(r.leadId);
    assert.equal(res.sent, 1);
    const text = received.at(-1)!;
    assert.match(text, /Пакет: STAR PARTY/);
    assert.match(text, /Предпочитаемая комната: Ice Room/);
    assert.match(text, /Дата: 04\.03\.2099/);
    assert.match(text, /Детей: 7/);
    assert.match(text, /Предпочитаемый слот: 14:00–18:00/);
    assert.equal((await outboxRow(r.leadId)).status, "sent", "sent only after Telegram answered ok");
  });

  it("Happy Party and Boom Bala Party are named in full as well", async () => {
    for (const [id, name, room, children] of [
      ["happy-party", "HAPPY PARTY", "roblox-room", 6],
      ["boom-bala-party", "BOOM BALA PARTY", "rapunzel-room", 10],
    ] as const) {
      received.length = 0;
      const r = await submitLead(db.pool, enquiry({ packageId: id, roomId: room, children, phone: `+7702${String(children).padStart(3, "0")}${String(id.length).padStart(4, "0")}` }));
      await drain(r.leadId);
      assert.match(received.at(-1)!, new RegExp(`Пакет: ${name}`));
      assert.match(received.at(-1)!, new RegExp(`Детей: ${children}`));
    }
  });

  it("a repeat of the same request (double tap, retry) makes no second enquiry and no second message", async () => {
    received.length = 0;
    const key = randomUUID();
    const first = await submitLead(db.pool, enquiry({ idempotencyKey: key, packageId: "star-party", phone: "+77011119999" }));
    const again = await submitLead(db.pool, enquiry({ idempotencyKey: key, packageId: "star-party", phone: "+77011119999" }));
    assert.equal(again.duplicate, true);
    assert.equal(again.leadId, first.leadId);
    await drain();
    assert.equal(received.filter((t) => t.includes("+7 701 111 99 99")).length, 1, "one message");
    const n = Number((await db.pool.query("SELECT count(*) n FROM bb.outbox WHERE ref_id = $1", [first.leadId])).rows[0].n);
    assert.equal(n, 1, "one notification task");
  });

  it("Telegram down: the task is NOT marked sent, it is retried later, and the enquiry is still safe in the CRM", async () => {
    mode = "down";
    const r = await submitLead(db.pool, enquiry({ packageId: "boom-bala-party", roomId: "magic-room", phone: "+77011117777", children: 10 }));
    const res = await drain(r.leadId);
    assert.equal(res.sent, 0);
    assert.equal(res.retry, 1);
    const row = await outboxRow(r.leadId);
    assert.equal(row.status, "pending", "no false delivery status");
    assert.ok(row.last_error_code, "the failure is recorded as a code");
    const lead = await db.pool.query("SELECT status FROM bb.lead_requests WHERE id = $1", [r.leadId]);
    assert.equal(lead.rows[0].status, "new", "the enquiry itself is kept");
  });

  it("the outbox is processed again when Telegram is back: delivered once, and no duplicate on a further run", async () => {
    mode = "ok";
    const row = await db.pool.query("SELECT ref_id FROM bb.outbox WHERE status = 'pending' AND last_error_code IS NOT NULL ORDER BY created_at LIMIT 1");
    const leadId = row.rows[0].ref_id as string;
    await db.pool.query("UPDATE bb.outbox SET next_attempt_at = now() WHERE ref_id = $1", [leadId]);
    received.length = 0;
    const res = await drain(leadId);
    assert.equal(res.sent, 1);
    assert.equal(received.length, 1);
    await drain(leadId);
    assert.equal(received.length, 1, "a further run does not resend");
    assert.equal((await outboxRow(leadId)).status, "sent");
  });

  it("a rejected message (bad chat) is a failure with its code, never a success", async () => {
    mode = "rejected";
    const r = await submitLead(db.pool, enquiry({ packageId: "star-party", phone: "+77011115555" }));
    const res = await drain(r.leadId);
    assert.equal(res.sent, 0);
    assert.equal((await outboxRow(r.leadId)).status, "pending");
    mode = "ok";
  });

  it("the owner's CRM view shows enquiries with the package names, not the ids", async () => {
    const r = await db.pool.query(
      `SELECT p.name FROM bb.lead_requests l LEFT JOIN bb.packages p ON p.id = l.package_id WHERE l.package_id IS NOT NULL ORDER BY l.seq`,
    );
    assert.ok(r.rows.every((x) => ["STAR PARTY", "HAPPY PARTY", "BOOM BALA PARTY"].includes(x.name)), JSON.stringify(r.rows));
    assert.ok(owner.id);
  });
});
