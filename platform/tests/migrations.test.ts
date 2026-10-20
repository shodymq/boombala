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

  it("has exactly the three fixed 4-hour slots", async () => {
    const { rows } = await db.pool.query("SELECT id, to_char(starts_at,'HH24:MI') s, to_char(ends_at,'HH24:MI') e FROM time_slots ORDER BY id");
    assert.deepEqual(rows, [
      { id: 1, s: "10:00", e: "14:00" },
      { id: 2, s: "14:00", e: "18:00" },
      { id: 3, s: "18:00", e: "22:00" },
    ]);
    await assert.rejects(() => db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (4, '22:00', '23:00')"), /check/i);
    await assert.rejects(() => db.pool.query("DELETE FROM time_slots WHERE id = 1"), /cannot be deleted/);
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
