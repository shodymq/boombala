import { createHash } from "node:crypto";
import { cleanName, nameKey, normalizePhone } from "../phone.ts";
import { isValidDate } from "../dates.ts";
import { COLUMNS, type Catalog, type Column, type NormalizedRow, type RawRow, type Reason, type SourceRef } from "./types.ts";

const HEADER_ALIASES: Record<Column, string[]> = {
  sourceId: ["sync id", "sheets sync id", "source id", "id синхронизации", "id записи", "идентификатор записи", "crm id"],
  date: ["дата"], time: ["время"], package: ["пакет", "наименование пакет", "наименование пакета", "программа"], animator: ["аниматор"],
  room: ["комната", "кабинка", "зал"], client: ["клиент", "заказчик", "имя"], phone: ["телефон", "тел", "номер"],
  child: ["ребенок", "ребёнок", "именинник", "имя ребенка"], age: ["возраст"], prepayment: ["предоплата"],
  children: ["количество детей", "кол-во детей", "детей", "дет"], adults: ["количество взрослых", "кол-во взрослых", "взрослых", "взр"],
  comment: ["комментарий", "примечание", "коммент", "comment", "notes"],
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

/**
 * "50 000", "50000 тг", "10к", "10к нал", "10к Сабина" -> KZT. "по факту" (pay at the event) is no prepayment.
 * Words after the amount (method, who took it) stay in the raw text only. Free text such as "внесена" is not an amount.
 */
export function parseAmount(raw: string): number | null | "bad" {
  const s = raw.trim().replace(/[‎‏‪-‮]/g, "");
  if (!s || /^по\s*факту$/i.test(s)) return null;
  const k = /^(\d{1,6})(?:[.,](\d))?\s*[кk]/i.exec(s);
  if (k) return Number(k[1]) * 1000 + (k[2] ? Number(k[2]) * 100 : 0);
  const digits = s.replace(/[\s ]/g, "").replace(/(тг|тенге|kzt|₸)\.?$/i, "");
  return /^\d{1,9}$/.test(digits) ? Number(digits) : "bad";
}

/** Guest counts: a plain integer, or approximate text ("7-8", "по факту", "≈15") that must never be guessed. */
export function parseCount(raw: string): { value: number | null; approx: boolean; bad: boolean } {
  const s = raw.trim();
  if (!s) return { value: null, approx: false, bad: false };
  if (/^\d{1,4}$/.test(s)) return { value: Number(s), approx: false, bad: false };
  const adults = /^(\d{1,4})\s*взросл/i.exec(s);
  if (adults) return { value: Number(adults[1]), approx: false, bad: false };
  if (/\d|по\s*факту/i.test(s)) return { value: null, approx: true, bad: false };
  return { value: null, approx: false, bad: true };
}

/** "8 лет", "3 годик" -> 8, 3. Several children ("8 лет, 6 лет") or free text -> null (never guessed). */
export function parseAge(raw: string): number | null {
  const m = /^(\d{1,2})\s*(?:лет|года?|годик|г\.?)?$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

const ROOM_ALIASES: Record<string, string[]> = {
  "roblox-room": ["роблокс"], "ice-room": ["айс"], "magic-room": ["мэджик"], "rapunzel-room": ["рапунцель"],
  "general-hall": ["общий зал", "общий зал 1 этаж"], "general-hall-2f": ["общий зал 2 этаж", "общий зал второй этаж"],
};
const PACKAGE_ALIASES: Record<string, string[]> = { "boom-party": ["boom bala party", "boom bala", "бум бала"] };
const dropWord = (n: string, w: RegExp) => n.replace(w, "").replace(/\s+/g, " ").trim();

/** Exact (normalised) match on catalog name, id or a known alias. No substring guessing: unknown stays unknown. */
export function resolveByName(raw: string, items: Array<{ id: string; name: string }>, kind: "room" | "package" = "room"): { id: string } | "ambiguous" | "unknown" | "missing" {
  const n = norm(raw);
  if (!n) return "missing";
  const strip = (x: string) => dropWord(x, kind === "room" ? /\b(room|рум)\b/g : /\bparty\b/g);
  const aliases = kind === "room" ? ROOM_ALIASES : PACKAGE_ALIASES;
  const key = strip(n);
  const hits = items.filter((i) => [i.name, i.id.replace(/-/g, " "), ...(aliases[i.id] ?? [])].map(norm).some((x) => x === n || strip(x) === key));
  if (hits.length === 1) return { id: hits[0].id };
  return hits.length > 1 ? "ambiguous" : "unknown";
}

const UNCERTAIN = /уточнить|согласовать|\?/i;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalizeRow(raw: RawRow, source: SourceRef, catalog: Catalog): NormalizedRow {
  const reasons: Reason[] = [];
  const date = parseDate(raw.date ?? "");
  if (!date) reasons.push((raw.date ?? "").trim() ? "date_unparseable" : "date_missing");
  const time = parseTime(raw.time ?? "");
  if (!time) reasons.push((raw.time ?? "").trim() ? "time_unparseable" : "time_missing");
  // Preserve the written HH:MM exactly. reconcile.ts sends off-hour starts to manual review; it never rounds them.

  const room = resolveByName(raw.room ?? "", catalog.rooms, "room");
  const roomId = typeof room === "object" ? room.id : null;
  if (room === "ambiguous") reasons.push("room_ambiguous");
  else if (room === "unknown") reasons.push("room_unknown");
  else if (room === "missing") reasons.push("room_missing");

  const pkg = resolveByName(raw.package ?? "", catalog.packages, "package");
  const packageId = typeof pkg === "object" ? pkg.id : null;
  if (pkg === "ambiguous" || pkg === "unknown") reasons.push("package_unknown");
  else if (pkg === "missing") reasons.push("package_missing");
  // The manager wrote that the booking itself is not settled ("уточнить", "согласовать"): never a candidate.
  if (UNCERTAIN.test(`${raw.package ?? ""} ${raw.room ?? ""}`)) reasons.push("unknown_status_text");

  const phoneRaw = (raw.phone ?? "").replace(/[‎‏‪-‮]/g, "").trim();
  const phoneE164 = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (!phoneRaw) reasons.push("phone_missing");
  else if (!phoneE164) reasons.push("phone_invalid");
  const customerName = cleanName(raw.client ?? "");
  if (!customerName) reasons.push("client_missing");

  const children = parseCount(raw.children ?? "");
  const adults = parseCount(raw.adults ?? "");
  if (children.bad || adults.bad) reasons.push("children_unparseable");
  if (children.approx || adults.approx) reasons.push("count_approximate");
  const ageText = (raw.age ?? "").trim();
  const childAge = ageText ? parseAge(ageText) : null;
  if (ageText && childAge === null) reasons.push("age_unparseable");

  const amount = parseAmount(raw.prepayment ?? "");
  if (amount === "bad") reasons.push("prepayment_unparseable");
  else if (amount === null) reasons.push("no_prepayment");
  else reasons.push("prepayment_unverified");
  // The sheet has no confirmation column: nothing here is ever a confirmed booking by itself.
  reasons.push("no_confirmation_flag", "time_semantics_unconfirmed");

  const base = {
    date, time, roomId, packageId, customerName, phoneE164,
    childName: cleanName(raw.child ?? ""), animator: cleanName(raw.animator ?? ""),
    children: children.value, adults: adults.value, childAge, prepay: typeof amount === "number" ? amount : null,
  };
  // Identity ignores the row number and the volatile fields (prepayment, counts) so edits update the same record.
  const sourceKey = sha(["v1", source.spreadsheetId, source.sheetId, date ?? "", time ?? "", roomId ?? norm(raw.room ?? ""), phoneE164 ?? norm(raw.phone ?? ""), nameKey(raw.child ?? "")].join("|"));
  const fingerprint = sha(JSON.stringify([base, norm(raw.room ?? ""), norm(raw.package ?? ""), norm(raw.prepayment ?? "")]));

  return {
    source, sourceKey, fingerprint, date, time, roomId, roomRaw: (raw.room ?? "").trim(), packageId, packageRaw: (raw.package ?? "").trim(),
    animator: base.animator, customerName, phoneE164, childName: base.childName, childAge,
    children: base.children, adults: base.adults, prepaymentCandidateKzt: base.prepay, prepaymentRaw: (raw.prepayment ?? "").trim(),
    status: "NEEDS_REVIEW", reasons: reasons as Reason[],
  };
}
