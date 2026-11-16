import { createHash } from "node:crypto";
import { cleanName, nameKey, normalizePhone } from "../phone.ts";
import { isValidDate } from "../dates.ts";
import { COLUMNS, type Catalog, type Column, type NormalizedRow, type RawRow, type Reason, type SourceRef } from "./types.ts";

const HEADER_ALIASES: Record<Column, string[]> = {
  date: ["дата"], time: ["время"], package: ["пакет", "программа"], animator: ["аниматор"], room: ["комната", "зал"],
  client: ["клиент", "заказчик"], phone: ["телефон", "тел"], child: ["ребенок", "ребёнок", "именинник"],
  age: ["возраст"], prepayment: ["предоплата"], children: ["количество детей", "кол-во детей", "детей"],
  adults: ["количество взрослых", "кол-во взрослых", "взрослых"],
};

const norm = (s: string) => s.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

/** Map header cells to canonical columns. Returns null if the mandatory columns cannot be found. */
export function mapHeader(cells: string[]): Record<number, Column> | null {
  const out: Record<number, Column> = {};
  const used = new Set<Column>();
  cells.forEach((cell, i) => {
    const n = norm(cell);
    for (const col of COLUMNS) {
      if (used.has(col)) continue;
      if (HEADER_ALIASES[col].some((a) => norm(a) === n)) { out[i] = col; used.add(col); break; }
    }
  });
  return used.has("date") && used.has("time") && used.has("phone") ? out : null;
}

export function rowFromCells(cells: string[], header: Record<number, Column>): RawRow {
  const row: RawRow = {};
  for (const [i, col] of Object.entries(header)) row[col] = (cells[Number(i)] ?? "").toString();
  return row;
}

export function isBlank(row: RawRow): boolean {
  return COLUMNS.every((c) => !(row[c] ?? "").trim());
}

/** dd.mm.yyyy, dd.mm.yy, yyyy-mm-dd, dd/mm/yyyy. Never guesses a month/day swap. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: string, mo: string, d: string;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s))) {
    [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isValidDate(iso) ? iso : null;
}

/** HH:MM or H.MM or H:MM:SS. Minutes are preserved exactly (14:30 stays 14:30). */
export function parseTime(raw: string): string | null {
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

export function parseInt0(raw: string): number | null | "bad" {
  const s = raw.trim();
  if (!s) return null;
  return /^\d{1,4}$/.test(s) ? Number(s) : "bad";
}

/** "50 000", "50000 тг", "50 000₸" -> 50000. Text like "внесена" is not an amount. */
export function parseAmount(raw: string): number | null | "bad" {
  const s = raw.trim();
  if (!s) return null;
  const digits = s.replace(/[\s ]/g, "").replace(/(тг|тенге|kzt|₸)\.?$/i, "");
  return /^\d{1,9}$/.test(digits) ? Number(digits) : "bad";
}

/** Resolve a room label to exactly one catalog room; "ambiguous" when several match, "unknown" when none. */
export function resolveByName(raw: string, items: Array<{ id: string; name: string }>): { id: string } | "ambiguous" | "unknown" | "missing" {
  const n = norm(raw);
  if (!n) return "missing";
  const exact = items.filter((i) => norm(i.name) === n || i.id === n);
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return "ambiguous";
  const partial = items.filter((i) => norm(i.name).includes(n) || n.includes(norm(i.name)));
  if (partial.length === 1) return { id: partial[0].id };
  return partial.length > 1 ? "ambiguous" : "unknown";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalizeRow(raw: RawRow, source: SourceRef, catalog: Catalog): NormalizedRow {
  const reasons: Reason[] = [];
  const date = parseDate(raw.date ?? "");
  if (!date) reasons.push((raw.date ?? "").trim() ? "date_unparseable" : "date_missing");
  const time = parseTime(raw.time ?? "");
  if (!time) reasons.push((raw.time ?? "").trim() ? "time_unparseable" : "time_missing");
  // Any valid HH:MM start is allowed (13:15, 16:40 ...). Duration is fixed at four hours with no buffer; see reconcile.ts.

  const room = resolveByName(raw.room ?? "", catalog.rooms);
  const roomId = typeof room === "object" ? room.id : null;
  if (room === "ambiguous") reasons.push("room_ambiguous");
  else if (room === "unknown") reasons.push("room_unknown");
  else if (room === "missing") reasons.push("room_missing");

  const pkg = resolveByName(raw.package ?? "", catalog.packages);
  const packageId = typeof pkg === "object" ? pkg.id : null;
  if (pkg === "ambiguous" || pkg === "unknown") reasons.push("package_unknown");
  else if (pkg === "missing") reasons.push("package_missing");

  const phoneRaw = (raw.phone ?? "").trim();
  const phoneE164 = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (!phoneRaw) reasons.push("phone_missing");
  else if (!phoneE164) reasons.push("phone_invalid");
  const customerName = cleanName(raw.client ?? "");
  if (!customerName) reasons.push("client_missing");

  const children = parseInt0(raw.children ?? "");
  const age = parseInt0(raw.age ?? "");
  if (children === "bad") reasons.push("children_unparseable");
  if (age === "bad") reasons.push("age_unparseable");
  const adults = parseInt0(raw.adults ?? "");

  const amount = parseAmount(raw.prepayment ?? "");
  if (amount === "bad") reasons.push("prepayment_unparseable");
  else if (amount === null) reasons.push("no_prepayment");
  else reasons.push("prepayment_unverified");
  // The sheet has no confirmation column: nothing here is ever a confirmed booking by itself.
  reasons.push("no_confirmation_flag", "time_semantics_unconfirmed");

  const base = {
    date, time, roomId, packageId, customerName, phoneE164,
    childName: cleanName(raw.child ?? ""), animator: cleanName(raw.animator ?? ""),
    children: typeof children === "number" ? children : null, adults: typeof adults === "number" ? adults : null,
    childAge: typeof age === "number" ? age : null, prepay: typeof amount === "number" ? amount : null,
  };
  // Identity ignores the row number and the volatile fields (prepayment, counts) so edits update the same record.
  const sourceKey = sha(["v1", source.spreadsheetId, source.sheetId, date ?? "", time ?? "", roomId ?? norm(raw.room ?? ""), phoneE164 ?? norm(raw.phone ?? ""), nameKey(raw.child ?? "")].join("|"));
  const fingerprint = sha(JSON.stringify([base, norm(raw.room ?? ""), norm(raw.package ?? "")]));

  return {
    source, sourceKey, fingerprint, date, time, roomId, roomRaw: (raw.room ?? "").trim(), packageId, packageRaw: (raw.package ?? "").trim(),
    animator: base.animator, customerName, phoneE164, childName: base.childName, childAge: base.childAge,
    children: base.children, adults: base.adults, prepaymentCandidateKzt: base.prepay, prepaymentRaw: (raw.prepayment ?? "").trim(),
    status: "NEEDS_REVIEW", reasons: reasons as Reason[],
  };
}
