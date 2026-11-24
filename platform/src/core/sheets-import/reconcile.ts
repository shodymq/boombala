import { nameKey } from "../phone.ts";
import type { CrmSnapshot, NormalizedRow, Reason } from "./types.ts";

const HARD: ReadonlySet<Reason> = new Set<Reason>([
  "date_unparseable", "date_missing", "time_unparseable", "time_missing", "start_not_whole_hour", "outside_working_hours", "room_unknown", "room_ambiguous",
  "room_missing", "package_unknown", "package_missing", "phone_invalid", "phone_missing", "client_missing", "prepayment_unparseable",
  "duplicate_in_sheet", "overlap_in_sheet", "overlap_with_crm", "overlap_with_crm_block", "matches_crm_conflicting", "children_unparseable", "unknown_status_text",
]);

/** Fixed duration, zero buffer: an event starting exactly when another ends is adjacent, not overlapping. */
export const BOOKING_MINUTES = 4 * 60;
const FOUR_HOURS = BOOKING_MINUTES;

export interface ReconcileOptions {
  /** Branch working window in minutes after midnight. When given, a four-hour event must fit inside it. */
  workingHours?: { openMin: number; closeMin: number };
}
const minutes = (date: string, time: string) => Date.parse(`${date}T00:00:00Z`) / 60000 + Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function add(row: NormalizedRow, reason: Reason) {
  if (!row.reasons.includes(reason)) row.reasons.push(reason);
}

/**
 * Pure classification. Mutates only the rows it is given. Never produces "confirmed": the strongest outcome is
 * CANDIDATE, which still needs a manager. `today` is the Asia/Almaty calendar date.
 */
export function reconcile(rows: NormalizedRow[], crm: CrmSnapshot, today: string, opts: ReconcileOptions = {}): NormalizedRow[] {
  for (const r of rows) {
    if (!r.time) continue;
    const t = Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3, 5));
    if (t % 60 !== 0) add(r, "start_not_whole_hour");
    if (opts.workingHours && (t < opts.workingHours.openMin || t + FOUR_HOURS > opts.workingHours.closeMin)) {
      add(r, "outside_working_hours");
    }
  }

  // 1. Exact duplicates inside the sheet: keep the first, the rest get a distinct occurrence key so nothing collides.
  const seen = new Map<string, number>();
  for (const r of rows) {
    const n = (seen.get(r.sourceKey) ?? 0) + 1;
    seen.set(r.sourceKey, n);
    if (n > 1) { r.sourceKey = `${r.sourceKey}#${n}`; add(r, "duplicate_in_sheet"); }
  }
  for (const r of rows) if (r.sourceKey.includes("#")) { const base = rows.find((x) => x.sourceKey === r.sourceKey.split("#")[0]); if (base) add(base, "duplicate_in_sheet"); }

  // 2. Overlaps in the sheet: same room, four-hour intervals intersect.
  const placed = rows.filter((r) => r.date && r.time && r.roomId);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.roomId !== b.roomId || a.sourceKey.split("#")[0] === b.sourceKey.split("#")[0]) continue;
      const sa = minutes(a.date!, a.time!), sb = minutes(b.date!, b.time!);
      if (sa < sb + FOUR_HOURS && sb < sa + FOUR_HOURS) { add(a, "overlap_in_sheet"); add(b, "overlap_in_sheet"); }
    }
  }

  // 3. CRM comparison (read-only snapshot).
  for (const r of rows) {
    if (!r.date || !r.time) continue;
    const rs = minutes(r.date, r.time);
    let matched = false;
    for (const res of crm.reservations) {
      if (res.roomId !== r.roomId) continue;
      const cs = minutes(res.date, res.startTime);
      if (cs === rs) {
        matched = true;
        if (res.phoneE164 && r.phoneE164 && res.phoneE164 !== r.phoneE164) add(r, "matches_crm_conflicting");
        if (res.children != null && r.children != null && res.children !== r.children) add(r, "matches_crm_conflicting");
        if (res.packageId && r.packageId && res.packageId !== r.packageId) add(r, "matches_crm_conflicting");
      } else if (cs < rs + FOUR_HOURS && rs < cs + FOUR_HOURS) add(r, "overlap_with_crm");
    }
    for (const block of crm.blocks) {
      if (block.roomId !== r.roomId) continue;
      const bs = minutes(block.date, block.startTime);
      if (bs < rs + FOUR_HOURS && rs < bs + FOUR_HOURS) add(r, "overlap_with_crm_block");
    }
    for (const lead of crm.leads) {
      if (lead.date !== r.date || !r.phoneE164 || lead.phoneE164 !== r.phoneE164) continue;
      if (lead.nameKey && r.customerName && lead.nameKey !== nameKey(r.customerName)) continue; // same phone, other person: not a match
      matched = true;
      if (lead.children != null && r.children != null && lead.children !== r.children) add(r, "matches_crm_conflicting");
      if (lead.packageId && r.packageId && lead.packageId !== r.packageId) add(r, "matches_crm_conflicting");
      if (lead.roomId && r.roomId && lead.roomId !== r.roomId) add(r, "matches_crm_conflicting");
    }
    (r as NormalizedRow & { _matched?: boolean })._matched = matched;
  }

  // 4. Final status.
  for (const r of rows) {
    const matched = (r as NormalizedRow & { _matched?: boolean })._matched === true;
    delete (r as NormalizedRow & { _matched?: boolean })._matched;
    const hard = r.reasons.some((x) => HARD.has(x));
    if (r.date && r.date < today) { add(r, "past_event"); r.status = "ARCHIVE_ONLY"; }
    else if (matched && !hard) r.status = "ALREADY_IN_CRM";
    else if (hard) r.status = "NEEDS_REVIEW";
    else r.status = "CANDIDATE";
  }
  return rows;
}

export interface Summary {
  total: number;
  future: number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  futureCandidates: number;
  needsReview: number;
  matchedCrm: number;
  withoutPrepayment: number;
}

/** Aggregates only: safe for CI logs and reports. */
export function summarize(rows: NormalizedRow[], today: string): Summary {
  const byStatus: Record<string, number> = {}, byReason: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    for (const x of r.reasons) byReason[x] = (byReason[x] ?? 0) + 1;
  }
  const future = rows.filter((r) => r.date && r.date >= today);
  return {
    total: rows.length, future: future.length, byStatus, byReason,
    futureCandidates: future.filter((r) => r.status === "CANDIDATE").length,
    needsReview: rows.filter((r) => r.status === "NEEDS_REVIEW").length,
    matchedCrm: byStatus.ALREADY_IN_CRM ?? 0,
    withoutPrepayment: rows.filter((r) => r.reasons.includes("no_prepayment")).length,
  };
}
