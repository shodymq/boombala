import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "../../src/core/db.ts";
import { migrate } from "../../src/core/migrate.ts";
import { MIGRATIONS_DIR, makeUser, seedFromSite, startTestDb, type TestDb } from "./db.ts";

export const FUTURE = "2099-06-15";

/** A test database with migrations up to (and including) `upTo`; 14 = what production runs today, 15 = after the kernel change. */
export async function dbAt(upTo: number): Promise<TestDb> {
  const db = await startTestDb({ migrate: false });
  const dir = mkdtempSync(join(tmpdir(), "bbmig-"));
  for (const f of readdirSync(MIGRATIONS_DIR)) if (/^\d+_/.test(f) && Number(f.slice(0, 3)) <= upTo) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  await migrate(db.pool, dir);
  rmSync(dir, { recursive: true, force: true });
  await seedFromSite(db.pool);
  return db;
}

export async function seedBooking(pool: Pool, opts: { slotId: number; phone: string; room?: string }) {
  const user = await makeUser(pool, "owner", `o${opts.slotId}${opts.phone.slice(-3)}${opts.room ?? ""}@example.test`);
  const c = await pool.query<{ id: string }>(
    "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('Тест', 'тест', $1, 'manual') RETURNING id", [opts.phone]);
  const room = opts.room ?? "magic-room";
  const pkg = (await pool.query<{ id: string }>("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, created_by)
     VALUES ('booking', $1, $2, $3, $4, $5, 8, 1000, 'base', $6) RETURNING id`, [FUTURE, opts.slotId, room, c.rows[0].id, pkg, user.id]);
  return r.rows[0].id;
}


/** An active manual block (kind = 'block'): it occupies a room but is not a booking. */
export async function seedBlock(pool: Pool, opts: { slotId: number; room: string }) {
  const user = await makeUser(pool, "owner", `blk${opts.slotId}${opts.room}@example.test`);
  await pool.query(
    "INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, note, created_by) VALUES ('block', $1, $2, $3, 'test block', $4)",
    [FUTURE, opts.slotId, opts.room, user.id]);
}

/** A real request (lead) so the CRM is not empty. */
export async function seedLead(pool: Pool, phone: string) {
  const c = await pool.query<{ id: string }>("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('Заявитель', 'заявитель', $1, 'birthday_form') RETURNING id", [phone]);
  await pool.query("INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, children) VALUES (gen_random_uuid(), $1, '2099-07-01', 9)", [c.rows[0].id]);
}
