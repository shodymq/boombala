import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseCsv, readCsv } from "../src/core/sheets-import/csv.ts";
import { normalizeRow } from "../src/core/sheets-import/normalize.ts";
import { reconcile } from "../src/core/sheets-import/reconcile.ts";
import { almatyToday } from "../src/core/dates.ts";
import { parseWorkingHours, toMinutes, formatMinutes } from "../src/core/booking-calendar.ts";

// Manager review of the FUTURE rows of the sheet. Two steps, both local, neither touches a database or FastAPI:
//   export --csv sheet.csv --spreadsheet <id> --out review.csv [--catalog catalog.json] [--hours 10:00-23:00]
//   plan   --review review.csv --out plan.json
// Both files hold personal data: they are written with mode 600 and must stay on the machine (never in Git).
// Nothing here creates a payment fact. A sheet value is only ever a *candidate*; the manager types the verified money.
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const cmd = process.argv[2];
const need = (n: string) => { const v = arg(n); if (!v) { console.error(`--${n} is required`); process.exit(2); } return v; };
const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;

const DEFAULT_CATALOG = {
  rooms: [{ id: "roblox-room", name: "Roblox Room" }, { id: "ice-room", name: "Ice Room" }, { id: "magic-room", name: "Magic Room" }, { id: "rapunzel-room", name: "Rapunzel Room" }],
  packages: [{ id: "wow-party", name: "WOW PARTY" }, { id: "magic-party", name: "MAGIC PARTY" }, { id: "boom-party", name: "BOOM PARTY" }],
};
const HEADER = ["key", "row", "date", "start", "end(+240)", "room", "package", "client", "phone", "child", "age", "children", "adults",
  "sheet_prepayment_candidate_kzt(NOT verified)", "sheet_status", "reasons", "production_match", "conflict",
  "manager_decision(real|cancel|moved|unknown|block)", "manager_new_date", "manager_new_time", "manager_new_room",
  "manager_agreed_price_kzt", "manager_verified_prepayment_kzt", "manager_prepayment_method(cash|card_terminal|bank_transfer|other_manual)", "manager_note"] as const;
const end = (t: string | null) => (t && toMinutes(t) !== null ? formatMinutes((toMinutes(t) as number) + 240) : "");

if (cmd === "export") {
  const catalog = arg("catalog") ? JSON.parse(readFileSync(arg("catalog")!, "utf8")) : DEFAULT_CATALOG;
  const hours = arg("hours") ? parseWorkingHours(arg("hours")) : null;
  const sheet = readCsv(readFileSync(need("csv"), "utf8"), { spreadsheetId: need("spreadsheet"), sheetId: Number(arg("sheet-id") ?? 0) });
  const today = almatyToday();
  const rows = reconcile(sheet.rows.map((r) => normalizeRow(r.raw, r.source, catalog)), { leads: [], reservations: [], blocks: [] }, today, hours ? { workingHours: hours } : {});
  const future = rows.filter((r) => r.status !== "ARCHIVE_ONLY").sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const lines = [HEADER.join(",")];
  for (const r of future) {
    const conflict = r.reasons.some((x) => x.startsWith("overlap") || x === "duplicate_in_sheet" || x === "matches_crm_conflicting");
    const roomName = catalog.rooms.find((x: { id: string }) => x.id === r.roomId)?.name ?? r.roomRaw;
    const pkgName = catalog.packages.find((x: { id: string }) => x.id === r.packageId)?.name ?? r.packageRaw;
    lines.push([r.sourceKey, r.source.rowNumber, r.date, r.time, end(r.time), roomName, pkgName, r.customerName, r.phoneE164 ?? "", r.childName, r.childAge ?? "", r.children ?? "", r.adults ?? "",
      r.prepaymentCandidateKzt ?? "", r.status, r.reasons.filter((x) => x !== "no_confirmation_flag" && x !== "time_semantics_unconfirmed").join("|"),
      arg("production-report") ? "see production report" : "NOT_READ (no production access in this run)", conflict ? "YES" : "no", "", "", "", "", "", "", "", ""].map(q).join(","));
  }
  writeFileSync(need("out"), lines.join("\n"), { mode: 0o600 });
  console.log(JSON.stringify({ futureRows: future.length, needsReview: future.filter((r) => r.status === "NEEDS_REVIEW").length, candidates: future.filter((r) => r.status === "CANDIDATE").length, conflicts: future.filter((r) => r.reasons.some((x) => x.startsWith("overlap") || x === "duplicate_in_sheet")).length }));
} else if (cmd === "plan") {
  const [head, ...body] = parseCsv(readFileSync(need("review"), "utf8")).filter((r) => r.some((c) => c.trim()));
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const ix = Object.fromEntries(HEADER.map((h) => [h, col(h.split("(")[0])]));
  const plan: Array<Record<string, unknown>> = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const c of body) {
    const g = (h: (typeof HEADER)[number]) => (c[ix[h]] ?? "").trim();
    const decision = g("manager_decision(real|cancel|moved|unknown|block)").toLowerCase();
    if (!decision) { skip("undecided"); continue; }
    if (decision === "cancel") { skip("cancelled_by_manager"); continue; }
    if (decision === "unknown") { skip("manager_unknown_status"); continue; }
    if (!["real", "moved", "block"].includes(decision)) { skip("bad_decision"); continue; }
    const moved = decision === "moved";
    const date = moved ? g("manager_new_date") : g("date");
    const start = moved ? g("manager_new_time") : g("start");
    const room = moved ? g("manager_new_room") : g("room");
    const base = { sourceKey: g("key"), decision, date, start, end: end(start), roomName: room, idempotencyKey: `sheet:${g("key")}` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || toMinutes(start) === null || !room) { skip("incomplete_place"); continue; }
    if (decision === "block") { plan.push({ ...base, kind: "block", reason: g("manager_note") || "Занято (из журнала)" }); continue; }
    const price = Number(g("manager_agreed_price_kzt"));
    const paid = Number(g("manager_verified_prepayment_kzt"));
    const method = g("manager_prepayment_method(cash|card_terminal|bank_transfer|other_manual)");
    // The kernel refuses a confirmation without a recorded prepayment, and a payment fact must be a number the manager verified.
    if (!(price > 0)) { skip("needs_agreed_price"); continue; }
    if (!(paid > 0) || !["cash", "card_terminal", "bank_transfer", "other_manual"].includes(method)) { skip("needs_verified_prepayment"); continue; }
    plan.push({ ...base, kind: "booking", packageName: g("package"), customerName: g("client"), phone: g("phone"), childName: g("child"), guestCount: Number(g("children")) || undefined, agreedPriceKzt: price, prepaymentKzt: paid, prepaymentMethod: method, note: [g("child") && `Ребёнок: ${g("child")}${g("age") ? `, ${g("age")}` : ""}`, "Импорт из журнала", g("manager_note")].filter(Boolean).join(". ").slice(0, 300) });
  }
  writeFileSync(need("out"), JSON.stringify({ createdAt: new Date().toISOString(), items: plan }, null, 1), { mode: 0o600 });
  console.log(JSON.stringify({ planned: plan.length, bookings: plan.filter((p) => p.kind === "booking").length, blocks: plan.filter((p) => p.kind === "block").length, skipped }));
} else {
  console.error("usage: sheets-manager-review.ts export|plan (see the header of this file)");
  process.exit(2);
}
void existsSync;
