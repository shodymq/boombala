import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { migrate } from "../src/core/migrate.ts";
import { MIGRATIONS_DIR, startTestDb, type TestDb } from "./helpers/db.ts";

describe("migrations and DB-level guarantees", () => {
  let db: TestDb;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  it("is idempotent: a second run applies nothing", async () => {
    const second = await migrate(db.pool, MIGRATIONS_DIR);
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length);
  });

  it("refuses an already applied migration that was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-mig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "001_core.sql"), "-- tampered\nSELECT 1;");
      await assert.rejects(() => migrate(db.pool, dir), /changed after it was applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing migration rolls back completely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-mig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "999_broken.sql"), "CREATE TABLE half_done (id int); SELECT 1/0;");
      await assert.rejects(() => migrate(db.pool, dir), /999_broken.sql failed/);
      const { rows } = await db.pool.query("SELECT to_regclass('half_done') AS t");
      assert.equal(rows[0].t, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps historical slots and accepts minute-precise four-hour starts", async () => {
    const { rows } = await db.pool.query("SELECT id, to_char(starts_at,'HH24:MI') s, to_char(ends_at,'HH24:MI') e FROM time_slots ORDER BY starts_at, id");
    assert.deepEqual(rows, [
      { id: 1, s: "10:00", e: "14:00" },
      { id: 4, s: "11:00", e: "15:00" },
      { id: 5, s: "12:00", e: "16:00" },
      { id: 6, s: "13:00", e: "17:00" },
      { id: 2, s: "14:00", e: "18:00" },
      { id: 7, s: "15:00", e: "19:00" },
      { id: 8, s: "16:00", e: "20:00" },
      { id: 9, s: "17:00", e: "21:00" },
      { id: 3, s: "18:00", e: "22:00" },
    ]);
    await db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (10, '13:15', '17:15')");
    await assert.rejects(() => db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (11, '13:16', '17:00')"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (12, '13:15', '17:15')"), /unique/i);
    await assert.rejects(() => db.pool.query("DELETE FROM time_slots WHERE id = 1"), /cannot be deleted/);
  });

  it("017 preserves existing reservation IDs and makes only the named general halls non-exclusive", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "bb-before-017-"));
    const pre017 = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "017_sheets_live_sync.sql")) {
        cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
      }
      await migrate(pre017.pool, oldDir);
      const user = await pre017.pool.query<{ id: string }>("INSERT INTO users (email,name,password_hash,role) VALUES ('migration-017@example.test','Migration test','x','manager') RETURNING id");
      await pre017.pool.query("INSERT INTO rooms (id,name) VALUES ('legacy-room-preserve','Legacy room')");
      const before = await pre017.pool.query<{ id: string }>(
        "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-01-20',NULL,'legacy-room-preserve','kept', $1,'2099-01-20 10:00:00+05','2099-01-20 14:00:00+05') RETURNING id", [user.rows[0].id]);
      await migrate(pre017.pool, MIGRATIONS_DIR);
      const after = await pre017.pool.query<{ id: string; occupancy_key: string }>("SELECT id,occupancy_key FROM slot_reservations WHERE id=$1", [before.rows[0].id]);
      assert.deepEqual(after.rows, [{ id: before.rows[0].id, occupancy_key: "legacy-room-preserve" }]);
      assert.equal((await pre017.pool.query("SELECT 1 FROM rooms WHERE id='general-hall' AND occupancy_mode='shared'")).rowCount, 1);
      assert.equal((await pre017.pool.query("SELECT 1 FROM rooms WHERE id='general-hall-2f' AND occupancy_mode='shared'")).rowCount, 1);
    } finally {
      await pre017.stop();
      rmSync(oldDir, { recursive: true, force: true });
    }

    const collisionDb = await startTestDb({ migrate: false });
    const collisionDir = mkdtempSync(join(tmpdir(), "bb-room-collision-"));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "017_sheets_live_sync.sql")) {
        cpSync(join(MIGRATIONS_DIR, file), join(collisionDir, file));
      }
      await migrate(collisionDb.pool, collisionDir);
      await collisionDb.pool.query("INSERT INTO rooms (id,name) VALUES ('general-hall','Occupied legacy catalog name')");
      await assert.rejects(() => migrate(collisionDb.pool, MIGRATIONS_DIR), /017_sheets_live_sync\.sql failed: general-hall catalog collision/);
      const unchanged = await collisionDb.pool.query("SELECT name FROM rooms WHERE id='general-hall'");
      assert.equal(unchanged.rows[0].name, "Occupied legacy catalog name");
      assert.equal((await collisionDb.pool.query("SELECT to_regclass('bb.sheet_sync_runs') t")).rows[0].t, null);
    } finally {
      await collisionDb.stop();
      rmSync(collisionDir, { recursive: true, force: true });
    }

    const actor = await db.pool.query<{ id: string }>("INSERT INTO users (email,name,password_hash,role) VALUES ('shared-zone@example.test','Shared zone test','x','manager') RETURNING id");
    const sharedOne = await db.pool.query<{ id: string }>(
      "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'general-hall','one',$1,'2099-02-20 10:00:00+05','2099-02-20 14:00:00+05') RETURNING id", [actor.rows[0].id]);
    const sharedTwo = await db.pool.query<{ id: string }>(
      "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'general-hall','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05') RETURNING id", [actor.rows[0].id]);
    assert.notEqual(sharedOne.rows[0].id, sharedTwo.rows[0].id);
    await db.pool.query("INSERT INTO rooms (id,name) VALUES ('exclusive-zone-test','Exclusive test')");
    await db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','one',$1,'2099-02-20 10:00:00+05','2099-02-20 14:00:00+05')", [actor.rows[0].id]);
    await assert.rejects(() => db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05')", [actor.rows[0].id]), (error: { code?: string }) => error.code === "23P01");
  });

  it("018 on top of populated 017 keeps every old package, price, reservation and payment; legacy sale flags wait for site cutover", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "bb-before-018-"));
    const pre018 = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "018")) cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
      await migrate(pre018.pool, oldDir);
      const q = (sql: string, p: unknown[] = []) => pre018.pool.query(sql, p);
      await q("INSERT INTO packages (id,name,sort_order) VALUES ('wow-party','WOW PARTY',0),('magic-party','MAGIC PARTY',1),('boom-party','BOOM PARTY',2)");
      await q("INSERT INTO price_rules (package_id,rule_type,amount_kzt) VALUES ('wow-party','base',37900),('wow-party','weekday',26530),('boom-party','base',79990)");
      const user = (await q("INSERT INTO users (email,name,password_hash,role) VALUES ('m018@example.test','M','x','manager') RETURNING id")).rows[0].id;
      const contact = (await q("INSERT INTO contacts (name,name_key,phone_e164,source) VALUES ('Историч','историч','+77075550999','manual') RETURNING id")).rows[0].id;
      const lead = (await q("INSERT INTO lead_requests (idempotency_key,contact_id,package_id,requested_date,children,status) VALUES (gen_random_uuid(),$1,'wow-party','2099-03-10',6,'confirmed') RETURNING id", [contact])).rows[0].id;
      const reservation = (await q(
        `INSERT INTO slot_reservations (kind,slot_date,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,created_by,starts_at,ends_at)
         SELECT 'booking','2099-03-10',id,$1,$2,'wow-party',6,37900,'base',$3,'2099-03-10 13:00+05','2099-03-10 17:00+05' FROM rooms ORDER BY sort_order LIMIT 1 RETURNING id`,
        [lead, contact, user],
      )).rows[0].id;
      await q("INSERT INTO manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,recorded_by) VALUES ($1,10000,'cash','key-018-history',$2)", [lead, user]);
      const before = {
        prices: (await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n,
        reservation: (await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0],
      };

      await migrate(pre018.pool, MIGRATIONS_DIR);

      assert.deepEqual((await q("SELECT id,is_active FROM packages ORDER BY id")).rows.map((r) => `${r.id}:${r.is_active}`), [
        "boom-bala-party:true", "boom-party:true", "happy-party:true", "magic-party:true", "star-party:true", "wow-party:true",
      ]);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 0, "the migration does not retire legacy IDs before the site switch");
      assert.equal((await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n, before.prices, "price history is untouched");
      assert.deepEqual((await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0], before.reservation, "the booking and its agreed price are untouched");
      assert.equal((await q("SELECT count(*)::int n FROM manual_payment_facts WHERE lead_request_id=$1", [lead])).rows[0].n, 1, "the payment fact is untouched");
      assert.equal((await q("SELECT status FROM lead_requests WHERE id=$1", [lead])).rows[0].status, "confirmed");
      assert.equal((await q("SELECT count(*)::int n FROM booking_cards")).rows[0].n, 0, "no card is invented for an old booking");
      // Once explicitly archived after cutover, a later seed/update cannot reopen the legacy ID.
      await q("INSERT INTO package_archive (package_id, reason) VALUES ('magic-party','test retirement')");
      await q("UPDATE packages SET is_active = false WHERE id = 'magic-party'");
      await q("UPDATE packages SET is_active = true WHERE id = 'magic-party'");
      assert.equal((await q("SELECT is_active FROM packages WHERE id='magic-party'")).rows[0].is_active, false);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 1);
      // A booking card cannot reference a terms version that does not exist.
      await assert.rejects(() => q("INSERT INTO booking_cards (reservation_id,package_id,terms_version,created_by,updated_by) VALUES ($1,'wow-party','v9',$2,$2)", [reservation, user]), /foreign key/i);
    } finally {
      await pre018.stop();
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it("audit_log and price_rules are append-only", async () => {
    await db.pool.query("INSERT INTO audit_log (action) VALUES ('test.created')");
    await assert.rejects(() => db.pool.query("UPDATE audit_log SET action = 'test.changed'"), /append-only/);
    await assert.rejects(() => db.pool.query("DELETE FROM audit_log"), /append-only/);
    await assert.rejects(() => db.pool.query("TRUNCATE audit_log"), /append-only/);
    await db.pool.query("INSERT INTO packages (id, name) VALUES ('p1', 'P1')");
    await db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', 1000)");
    await assert.rejects(() => db.pool.query("UPDATE price_rules SET amount_kzt = 1"), /append-only/);
    await assert.rejects(() => db.pool.query("DELETE FROM price_rules"), /append-only/);
  });

  it("packages and rooms can never be deleted", async () => {
    await db.pool.query("INSERT INTO rooms (id, name) VALUES ('r1', 'R1')");
    await assert.rejects(() => db.pool.query("DELETE FROM rooms WHERE id = 'r1'"), /cannot be deleted/);
    await assert.rejects(() => db.pool.query("DELETE FROM packages WHERE id = 'p1'"), /cannot be deleted/);
  });

  it("price_rules enforces its shape", async () => {
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'date', 5000)"), /check/i); // date rule needs a date
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, rule_date, amount_kzt) VALUES ('p1', 'base', '2027-01-01', 5000)"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', NULL)"), /check/i); // only a date rule may clear
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', 0)"), /check/i);
    await db.pool.query("INSERT INTO price_rules (package_id, rule_type, rule_date, amount_kzt) VALUES ('p1', 'date', '2027-01-01', NULL)");
  });

  it("a user referenced by the audit log or price history cannot be deleted (deactivate instead)", async () => {
    const { rows } = await db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('hist@example.test', 'Hist', 'h', 'owner') RETURNING id");
    await db.pool.query("INSERT INTO audit_log (action, actor_user_id) VALUES ('test.acted', $1)", [rows[0].id]);
    await assert.rejects(() => db.pool.query("DELETE FROM users WHERE id = $1", [rows[0].id]), /foreign key|violates/i);
    const { rows: free } = await db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('free@example.test', 'Free', 'h', 'editor') RETURNING id");
    await db.pool.query("DELETE FROM users WHERE id = $1", [free[0].id]); // no history: deletable
  });

  it("e-mail must be stored lower-case and users need a valid role", async () => {
    await assert.rejects(() => db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('A@B.test', 'x', 'h', 'owner')"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('a@b.test', 'x', 'h', 'admin')"), /invalid input value/);
  });
});
