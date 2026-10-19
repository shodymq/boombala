import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";
import type { RequestMeta } from "./users.ts";

export const BUSINESS_TIME_ZONE = "Asia/Almaty";

export interface CatalogItem {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface TimeSlot {
  id: number;
  startsAt: string;
  endsAt: string;
}

export async function listPackages(db: Queryable): Promise<CatalogItem[]> {
  const { rows } = await db.query("SELECT id, name, sort_order, is_active FROM packages ORDER BY sort_order, id");
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active }));
}

export async function listRooms(db: Queryable): Promise<CatalogItem[]> {
  const { rows } = await db.query("SELECT id, name, sort_order, is_active FROM rooms ORDER BY sort_order, id");
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active }));
}

export async function listSlots(db: Queryable): Promise<TimeSlot[]> {
  const { rows } = await db.query<{ id: number; starts_at: string; ends_at: string }>(
    "SELECT id, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at FROM time_slots ORDER BY id",
  );
  return rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at }));
}

export type PriceSource = "date" | "weekday" | "base";
export interface ResolvedPrice {
  amountKzt: number;
  source: PriceSource;
}

/** Monday-Friday for a plain calendar date (no time zone involved). */
export function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Price of a package on a date. Hierarchy: special price for that date, then the weekday price (Mon-Fri),
 * then the regular price. `null` if the package has no price at all.
 */
export async function resolvePrice(db: Queryable, packageId: string, date: string): Promise<ResolvedPrice | null> {
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const { rows } = await db.query<{ rule_type: string; amount_kzt: number | null }>(
    `SELECT DISTINCT ON (rule_type, rule_date) rule_type, amount_kzt
       FROM price_rules
      WHERE package_id = $1 AND (rule_type <> 'date' OR rule_date = $2::date)
      ORDER BY rule_type, rule_date, id DESC`,
    [packageId, date],
  );
  const latest = new Map(rows.map((r) => [r.rule_type, r.amount_kzt]));
  const special = latest.get("date");
  if (special != null) return { amountKzt: special, source: "date" };
  const weekday = latest.get("weekday");
  if (weekday != null && isWeekday(date)) return { amountKzt: weekday, source: "weekday" };
  const base = latest.get("base");
  return base != null ? { amountKzt: base, source: "base" } : null;
}

export interface PriceRuleInput {
  packageId: string;
  ruleType: "base" | "weekday" | "date";
  /** Required for `date`, forbidden otherwise. */
  date?: string;
  /** `null` removes a special price (only for `date`). */
  amountKzt: number | null;
  note?: string;
}

/** Appends a price rule (history is never rewritten). Owner only. */
export async function setPriceRule(pool: Pool, actor: Actor, input: PriceRuleInput, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "prices.manage");
  const errors: Record<string, string> = {};
  if (!["base", "weekday", "date"].includes(input.ruleType)) errors.ruleType = "Неизвестный тип цены";
  if (input.ruleType === "date" && !(input.date && isValidDate(input.date))) errors.date = "Укажите дату";
  if (input.ruleType !== "date" && input.date) errors.date = "Дата нужна только для особой цены";
  const amountOk =
    input.amountKzt === null ? input.ruleType === "date" : Number.isInteger(input.amountKzt) && input.amountKzt >= 1 && input.amountKzt <= 100_000_000;
  if (!amountOk) errors.amountKzt = "Цена должна быть целым числом тенге больше нуля";
  if (input.note && input.note.length > 300) errors.note = "Не больше 300 символов";
  if (Object.keys(errors).length) throw new ValidationError(errors);

  await withTx(pool, async (tx) => {
    const pkg = await tx.query("SELECT 1 FROM packages WHERE id = $1", [input.packageId]);
    if (!pkg.rowCount) throw new ValidationError({ packageId: "Пакет не найден" });
    const date = input.ruleType === "date" ? input.date! : undefined;
    // 2099-01-02 is a Friday: for non-date rules it shows the weekday/base value that is being replaced.
    const before = await resolvePrice(tx, input.packageId, date ?? (input.ruleType === "weekday" ? "2099-01-02" : "2099-01-03"));
    await tx.query(
      "INSERT INTO price_rules (package_id, rule_type, rule_date, amount_kzt, created_by, note) VALUES ($1, $2, $3, $4, $5, $6)",
      [input.packageId, input.ruleType, date ?? null, input.amountKzt, actor.id, input.note?.trim() || null],
    );
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "price.set",
      entityType: "package",
      entityId: input.packageId,
      before: before ?? undefined,
      after: { ruleType: input.ruleType, date: date ?? null, amountKzt: input.amountKzt },
      ...meta,
    });
  });
}

export interface PriceHistoryRow {
  id: number;
  ruleType: string;
  date: string | null;
  amountKzt: number | null;
  createdAt: Date;
  createdBy: string | null;
  note: string | null;
}

export async function priceHistory(pool: Pool, actor: Actor, packageId: string, limit = 100): Promise<PriceHistoryRow[]> {
  assertCan(actor, "prices.manage");
  const { rows } = await pool.query(
    `SELECT p.id, p.rule_type, to_char(p.rule_date, 'YYYY-MM-DD') AS rule_date, p.amount_kzt, p.created_at, u.name AS created_by, p.note
       FROM price_rules p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.package_id = $1 ORDER BY p.id DESC LIMIT $2`,
    [packageId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    ruleType: r.rule_type,
    date: r.rule_date,
    amountKzt: r.amount_kzt,
    createdAt: r.created_at,
    createdBy: r.created_by,
    note: r.note,
  }));
}

export interface CatalogSummary {
  packages: Array<CatalogItem & { basePrice: number | null; weekdayPrice: number | null }>;
  rooms: CatalogItem[];
  slots: TimeSlot[];
}

/** Read-only overview for the dashboard: current regular and weekday prices per package. */
export async function catalogSummary(db: Queryable): Promise<CatalogSummary> {
  const [packages, rooms, slots] = await Promise.all([listPackages(db), listRooms(db), listSlots(db)]);
  const { rows } = await db.query<{ package_id: string; rule_type: string; amount_kzt: number }>(
    `SELECT DISTINCT ON (package_id, rule_type) package_id, rule_type, amount_kzt
       FROM price_rules WHERE rule_type IN ('base', 'weekday')
      ORDER BY package_id, rule_type, id DESC`,
  );
  const price = (pkg: string, type: string) => rows.find((r) => r.package_id === pkg && r.rule_type === type)?.amount_kzt ?? null;
  return {
    packages: packages.map((p) => ({ ...p, basePrice: price(p.id, "base"), weekdayPrice: price(p.id, "weekday") })),
    rooms,
    slots,
  };
}
