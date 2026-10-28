import type { Client, Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { cleanName, nameKey, normalizePhone } from "./phone.ts";
import { assertCan, type Actor } from "./rbac.ts";
import { canManagerTransition, type LeadStatus, type ManagerTarget } from "./lead-status.ts";
import { resolvePrice, type PriceSource } from "./catalog.ts";
import type { RequestMeta } from "./users.ts";

/**
 * Rules (enforced by PostgreSQL, see migration 006):
 *  - an enquiry (lead_requests) never occupies a slot;
 *  - a confirmed booking and a manual block each occupy exactly one (date, slot, room) cell;
 *  - one active reservation per cell, whoever writes it and however many at once (unique partial index).
 * This module only translates database refusals into domain errors; it never "checks, then inserts".
 */

const CELL_INDEX = "slot_reservations_active_cell_idx";
const LEAD_INDEX = "slot_reservations_active_lead_idx";

function mapDbError(error: unknown): never {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23505" && e.constraint === CELL_INDEX) throw new ConflictError("slot_taken");
  if (e?.code === "23505" && e.constraint === LEAD_INDEX) throw new ConflictError("lead_already_booked");
  if (typeof e?.message === "string" && e.message.includes("slot_started")) throw new ValidationError({ date: "Этот слот уже начался" });
  throw error;
}

export interface Cell {
  slotId: number;
  roomId: string;
  state: "free" | "booked" | "blocked";
  reservationId?: string;
  customer?: string;
  phone?: string;
  packageName?: string;
  priceKzt?: number;
  note?: string | null;
  /** Open enquiries that named exactly this room and slot. They do not occupy it. */
  pendingLeads: number;
}

export interface Grid {
  date: string;
  rooms: Array<{ id: string; name: string }>;
  slots: Array<{ id: number; startsAt: string; endsAt: string }>;
  cells: Cell[];
  /** Open enquiries for the date that did not name both a room and a slot. */
  unplacedLeads: number;
}

export async function getGrid(db: Queryable, actor: Actor, date: string): Promise<Grid> {
  assertCan(actor, "bookings.manage");
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const [rooms, slots, res, leads] = await Promise.all([
    db.query<{ id: string; name: string }>("SELECT id, name FROM bb.rooms WHERE is_active ORDER BY sort_order, id"),
    db.query<{ id: number; starts_at: string; ends_at: string }>(
      "SELECT id, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at FROM bb.time_slots ORDER BY id",
    ),
    db.query(
      `SELECT r.id, r.kind, r.slot_id, r.room_id, r.price_kzt, r.note, c.name AS customer, c.phone_e164, p.name AS package_name
         FROM bb.slot_reservations r
         LEFT JOIN bb.contacts c ON c.id = r.contact_id
         LEFT JOIN bb.packages p ON p.id = r.package_id
        WHERE r.slot_date = $1 AND r.released_at IS NULL`,
      [date],
    ),
    db.query<{ slot_id: number | null; room_id: string | null; n: number }>(
      `SELECT slot_id, room_id, count(*)::int AS n FROM bb.lead_requests
        WHERE requested_date = $1 AND status IN ('new', 'in_progress') GROUP BY slot_id, room_id`,
      [date],
    ),
  ]);
  const cells: Cell[] = [];
  for (const room of rooms.rows) {
    for (const slot of slots.rows) {
      const r = res.rows.find((x) => x.room_id === room.id && x.slot_id === slot.id);
      const pending = leads.rows.find((x) => x.room_id === room.id && x.slot_id === slot.id)?.n ?? 0;
      cells.push(
        r
          ? {
              slotId: slot.id,
              roomId: room.id,
              state: r.kind === "block" ? "blocked" : "booked",
              reservationId: r.id,
              customer: r.customer ?? undefined,
              phone: r.phone_e164 ?? undefined,
              packageName: r.package_name ?? undefined,
              priceKzt: r.price_kzt ?? undefined,
              note: r.note,
              pendingLeads: pending,
            }
          : { slotId: slot.id, roomId: room.id, state: "free", pendingLeads: pending },
      );
    }
  }
  const unplaced = leads.rows.filter((x) => !(x.room_id && x.slot_id)).reduce((s, x) => s + x.n, 0);
  return {
    date,
    rooms: rooms.rows,
    slots: slots.rows.map((s) => ({ id: s.id, startsAt: s.starts_at, endsAt: s.ends_at })),
    cells,
    unplacedLeads: unplaced,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────

async function checkTarget(tx: Client, date: string, slotId: unknown, roomId: unknown): Promise<{ slotId: number; roomId: string }> {
  const errors: Record<string, string> = {};
  if (typeof date !== "string" || !isValidDate(date)) errors.date = "Укажите дату";
  else if (date < almatyToday()) errors.date = "Нельзя занять прошедшую дату";
  const slot = Number(slotId);
  if (![1, 2, 3].includes(slot)) errors.slotId = "Выберите слот";
  if (typeof roomId !== "string" || !roomId) errors.roomId = "Выберите комнату";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const room = await tx.query("SELECT 1 FROM bb.rooms WHERE id = $1 AND is_active", [roomId]);
  if (!room.rowCount) throw new ValidationError({ roomId: "Комната недоступна" });
  return { slotId: slot, roomId: roomId as string };
}

async function priceOrFail(tx: Client, packageId: unknown, date: string): Promise<{ packageId: string; amountKzt: number; source: PriceSource }> {
  if (typeof packageId !== "string" || !packageId) throw new ValidationError({ packageId: "Выберите пакет" });
  const pkg = await tx.query("SELECT 1 FROM bb.packages WHERE id = $1 AND is_active", [packageId]);
  if (!pkg.rowCount) throw new ValidationError({ packageId: "Пакет недоступен" });
  const price = await resolvePrice(tx, packageId, date);
  if (!price) throw new ValidationError({ packageId: "Для пакета не задана цена" });
  return { packageId, amountKzt: price.amountKzt, source: price.source };
}

export interface ConfirmInput {
  leadId: string;
  /** Defaults to what the customer asked for in the enquiry. */
  date?: string;
  slotId?: number;
  roomId?: string;
  packageId?: string;
  note?: string;
}

/** Manager confirms an enquiry: this is the moment the cell becomes occupied and the price is frozen. */
export async function confirmLead(pool: Pool, actor: Actor, input: ConfirmInput, meta: RequestMeta = {}): Promise<{ reservationId: string }> {
  assertCan(actor, "bookings.manage");
  try {
    return await withTx(pool, async (tx) => {
      const lead = await tx.query<{ id: string; status: string; contact_id: string; requested_date: string; slot_id: number | null; room_id: string | null; package_id: string | null; children: number | null }>(
        `SELECT id, status, contact_id, to_char(requested_date, 'YYYY-MM-DD') AS requested_date, slot_id, room_id, package_id, children
           FROM bb.lead_requests WHERE id = $1 FOR UPDATE`,
        [input.leadId],
      );
      const l = lead.rows[0];
      if (!l) throw new ValidationError({ leadId: "Заявка не найдена" });
      if (l.status !== "new" && l.status !== "in_progress") throw new ConflictError("lead_not_open");
      const date = input.date ?? l.requested_date;
      const target = await checkTarget(tx, date, input.slotId ?? l.slot_id, input.roomId ?? l.room_id);
      const price = await priceOrFail(tx, input.packageId ?? l.package_id, date);
      const note = input.note?.trim() || null;
      if (note && note.length > 300) throw new ValidationError({ note: "Не больше 300 символов" });
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, lead_request_id, contact_id, package_id, children, price_kzt, price_source, note, created_by)
         VALUES ('booking', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [date, target.slotId, target.roomId, l.id, l.contact_id, price.packageId, l.children, price.amountKzt, price.source, note, actor.id],
      );
      await tx.query("UPDATE bb.lead_requests SET status = 'confirmed', slot_id = $2, room_id = $3, package_id = $4 WHERE id = $1", [l.id, target.slotId, target.roomId, price.packageId]);
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "booking.confirmed",
        entityType: "slot_reservation",
        entityId: ins.rows[0].id,
        after: { leadId: l.id, date, slotId: target.slotId, roomId: target.roomId, packageId: price.packageId, priceKzt: price.amountKzt, priceSource: price.source },
        ...meta,
      });
      return { reservationId: ins.rows[0].id };
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export interface ManualBookingInput {
  date: string;
  slotId: number;
  roomId: string;
  packageId: string;
  name: string;
  phone: string;
  children?: number | null;
  note?: string;
}

/** A booking taken outside the website (phone call, walk-in). Creates or reuses the contact, source "manual". */
export async function createManualBooking(pool: Pool, actor: Actor, input: ManualBookingInput, meta: RequestMeta = {}): Promise<{ reservationId: string }> {
  assertCan(actor, "bookings.manage");
  const name = cleanName(input.name ?? "");
  const phone = normalizePhone(String(input.phone ?? ""));
  const errors: Record<string, string> = {};
  if (name.length < 2 || name.length > 120) errors.name = "Укажите имя";
  if (!phone) errors.phone = "Проверьте номер телефона";
  const children = input.children ?? null;
  if (children !== null && !(Number.isInteger(children) && children >= 0 && children <= 200)) errors.children = "От 0 до 200";
  const note = input.note?.trim() || null;
  if (note && note.length > 300) errors.note = "Не больше 300 символов";
  if (Object.keys(errors).length || !phone) throw new ValidationError(errors);
  try {
    return await withTx(pool, async (tx) => {
      const target = await checkTarget(tx, input.date, input.slotId, input.roomId);
      const price = await priceOrFail(tx, input.packageId, input.date);
      const c = await tx.query<{ id: string }>(
        `INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, $3, 'manual')
         ON CONFLICT (phone_e164, name_key) DO UPDATE SET last_activity_at = now() RETURNING id`,
        [name, nameKey(name), phone],
      );
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, note, created_by)
         VALUES ('booking', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [input.date, target.slotId, target.roomId, c.rows[0].id, price.packageId, children, price.amountKzt, price.source, note, actor.id],
      );
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "booking.created_manual",
        entityType: "slot_reservation",
        entityId: ins.rows[0].id,
        after: { date: input.date, slotId: target.slotId, roomId: target.roomId, packageId: price.packageId, priceKzt: price.amountKzt },
        ...meta,
      });
      return { reservationId: ins.rows[0].id };
    });
  } catch (error) {
    return mapDbError(error);
  }
}

/** A manual block (maintenance, private event): occupies the cell exactly like a booking, carries no customer. */
export async function createBlock(pool: Pool, actor: Actor, input: { date: string; slotId: number; roomId: string; note?: string }, meta: RequestMeta = {}): Promise<{ reservationId: string }> {
  assertCan(actor, "bookings.manage");
  const note = input.note?.trim() || null;
  if (note && note.length > 300) throw new ValidationError({ note: "Не больше 300 символов" });
  try {
    return await withTx(pool, async (tx) => {
      const target = await checkTarget(tx, input.date, input.slotId, input.roomId);
      const ins = await tx.query<{ id: string }>(
        "INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, note, created_by) VALUES ('block', $1, $2, $3, $4, $5) RETURNING id",
        [input.date, target.slotId, target.roomId, note, actor.id],
      );
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "block.created",
        entityType: "slot_reservation",
        entityId: ins.rows[0].id,
        after: { date: input.date, slotId: target.slotId, roomId: target.roomId },
        ...meta,
      });
      return { reservationId: ins.rows[0].id };
    });
  } catch (error) {
    return mapDbError(error);
  }
}

/** Cancels a booking or removes a block. The row stays as history; the cell becomes free. */
export async function releaseReservation(pool: Pool, actor: Actor, reservationId: string, reason: string | undefined, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "bookings.manage");
  const why = reason?.trim() || null;
  if (why && why.length > 300) throw new ValidationError({ reason: "Не больше 300 символов" });
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ kind: string; lead_request_id: string | null }>(
      `UPDATE bb.slot_reservations SET released_at = now(), released_by = $2, release_reason = $3
        WHERE id = $1 AND released_at IS NULL RETURNING kind, lead_request_id`,
      [reservationId, actor.id, why],
    );
    if (!rows[0]) throw new ConflictError("already_released");
    if (rows[0].lead_request_id) await tx.query("UPDATE bb.lead_requests SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed'", [rows[0].lead_request_id]);
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: rows[0].kind === "block" ? "block.released" : "booking.cancelled",
      entityType: "slot_reservation",
      entityId: reservationId,
      after: { reason: why },
      ...meta,
    });
  });
}

// ── Enquiries (the manager's queue) ───────────────────────────────────────────────────────────────────────────

export interface LeadRow {
  id: string;
  seq: number;
  createdAt: Date;
  status: string;
  name: string;
  phone: string;
  requestedDate: string;
  slotId: number | null;
  roomId: string | null;
  packageId: string | null;
  children: number | null;
  reservationId: string | null;
}

export async function listLeads(pool: Pool, actor: Actor, filter: { status?: string } = {}, limit = 100): Promise<LeadRow[]> {
  assertCan(actor, "requests.manage");
  const params: unknown[] = [];
  let where = "";
  if (filter.status) {
    params.push(filter.status);
    where = "WHERE l.status = $1";
  }
  const { rows } = await pool.query(
    `SELECT l.id, l.seq, l.created_at, l.status, c.name, c.phone_e164, to_char(l.requested_date, 'YYYY-MM-DD') AS requested_date,
            l.slot_id, l.room_id, l.package_id, l.children,
            (SELECT r.id FROM bb.slot_reservations r WHERE r.lead_request_id = l.id AND r.released_at IS NULL) AS reservation_id
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id
       ${where} ORDER BY (l.status IN ('new', 'in_progress')) DESC, l.requested_date, l.seq DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, seq: Number(r.seq), createdAt: r.created_at, status: r.status, name: r.name, phone: r.phone_e164, requestedDate: r.requested_date,
    slotId: r.slot_id, roomId: r.room_id, packageId: r.package_id, children: r.children, reservationId: r.reservation_id,
  }));
}

/** in_progress / cancelled by hand. "confirmed" only comes from confirmLead; cancelling a confirmed lead goes through releaseReservation. */
export async function setLeadStatus(pool: Pool, actor: Actor, leadId: string, status: ManagerTarget, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "requests.manage");
  if (!(["new", "in_progress", "cancelled"] as const).includes(status)) throw new ValidationError({ status: "Недопустимый статус" });
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ status: LeadStatus }>("SELECT status FROM bb.lead_requests WHERE id = $1 FOR UPDATE", [leadId]);
    if (!rows[0]) throw new ValidationError({ leadId: "Заявка не найдена" });
    if (rows[0].status === status) return;
    if (!canManagerTransition(rows[0].status, status)) throw new ConflictError("lead_not_open");
    await tx.query("UPDATE bb.lead_requests SET status = $2 WHERE id = $1", [leadId, status]);
    await writeAudit(tx, { actorUserId: actor.id, action: "lead.status_changed", entityType: "lead_request", entityId: leadId, before: { status: rows[0].status }, after: { status }, ...meta });
  });
}

// ── Public availability (no personal data, never invented) ────────────────────────────────────────────────────

export interface DayAvailability {
  date: string;
  slots: Array<{ id: number; startsAt: string; endsAt: string; freeRoomIds: string[] }>;
  rooms: Array<{ id: string; name: string }>;
  prices: Record<string, { amountKzt: number; source: PriceSource } | null>;
}

export async function dayAvailability(db: Queryable, date: string): Promise<DayAvailability> {
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const [rooms, slots, taken, packages] = await Promise.all([
    db.query<{ id: string; name: string }>("SELECT id, name FROM bb.rooms WHERE is_active ORDER BY sort_order, id"),
    db.query<{ id: number; starts_at: string; ends_at: string }>(
      "SELECT id, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at FROM bb.time_slots ORDER BY id",
    ),
    db.query<{ slot_id: number; room_id: string }>("SELECT slot_id, room_id FROM bb.slot_reservations WHERE slot_date = $1 AND released_at IS NULL", [date]),
    db.query<{ id: string }>("SELECT id FROM bb.packages WHERE is_active ORDER BY sort_order, id"),
  ]);
  const prices: DayAvailability["prices"] = {};
  for (const p of packages.rows) prices[p.id] = await resolvePrice(db, p.id, date);
  return {
    date,
    rooms: rooms.rows,
    slots: slots.rows.map((s) => ({
      id: s.id,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      freeRoomIds: rooms.rows.filter((r) => !taken.rows.some((t) => t.slot_id === s.id && t.room_id === r.id)).map((r) => r.id),
    })),
    prices,
  };
}

/** Free rooms per slot for each day of a month that has at least one reservation; days not listed are entirely free. */
export async function monthAvailability(db: Queryable, month: string): Promise<{ month: string; roomCount: number; days: Record<string, Record<string, number>> }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError({ month: "Некорректный месяц" });
  const [rooms, taken] = await Promise.all([
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM bb.rooms WHERE is_active"),
    db.query<{ d: string; slot_id: number; n: number }>(
      `SELECT to_char(slot_date, 'YYYY-MM-DD') AS d, slot_id, count(*)::int AS n FROM bb.slot_reservations
        WHERE released_at IS NULL AND slot_date >= ($1 || '-01')::date AND slot_date < (($1 || '-01')::date + interval '1 month')
        GROUP BY slot_date, slot_id`,
      [month],
    ),
  ]);
  const roomCount = rooms.rows[0].n;
  const days: Record<string, Record<string, number>> = {};
  for (const t of taken.rows) {
    days[t.d] ??= { "1": roomCount, "2": roomCount, "3": roomCount };
    days[t.d][String(t.slot_id)] = Math.max(roomCount - t.n, 0);
  }
  return { month, roomCount, days };
}
