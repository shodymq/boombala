// Applies a MANAGER-APPROVED plan (from `sheets-manager-review.ts plan`) through the existing FastAPI booking writer, the same
// request -> recorded manual prepayment -> confirm sequence as the CRM calendar. It is the only writer: no SQL, no direct table access.
//   node scripts/sheets-apply-plan.mjs --plan plan.json --target local|staging|production --fastapi-url URL --branch-id ID \
//        --staff-email E --staff-id ID [--apply yes]
//   env: CRM_SERVICE_TOKEN, CRM_STAFF_ASSERTION_SECRET (same values as the Platform bridge; never printed)
// Default is a dry run (reads the timeline, writes nothing). `--target production` additionally needs
// ALLOW_PRODUCTION_APPLY=codex-cutover in the environment: the production cutover belongs to the release owner, not to this script's author.
// Re-running is safe: every item has a stable idempotency key derived from the sheet row identity, and a booking that already
// occupies the same room and start is reported as "already_present" instead of being created again.
// Output: counts and "<sourceKey prefix>: <result>" lines. No names, phones or amounts.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (n) => { const v = arg(n); if (!v) { console.error(`--${n} is required`); process.exit(2); } return v; };
const target = need("target");
const base = need("fastapi-url").replace(/\/+$/, "");
const apply = arg("apply") === "yes";
const host = new URL(base).hostname;
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
if (!["local", "staging", "production"].includes(target)) { console.error("--target must be local|staging|production"); process.exit(2); }
if (target === "local" && !loopback) { console.error("target local requires a loopback address"); process.exit(2); }
if (target === "staging" && (loopback ? false : !/staging/i.test(host))) { console.error("target staging requires a loopback address or a host name containing 'staging'"); process.exit(2); }
if (target === "production" && apply && process.env.ALLOW_PRODUCTION_APPLY !== "codex-cutover") { console.error("production writes are refused: this is the release owner's cutover step (ALLOW_PRODUCTION_APPLY)"); process.exit(3); }
const serviceToken = process.env.CRM_SERVICE_TOKEN, secret = process.env.CRM_STAFF_ASSERTION_SECRET;
if (!serviceToken || !secret) { console.error("CRM_SERVICE_TOKEN and CRM_STAFF_ASSERTION_SECRET are required"); process.exit(2); }

const plan = JSON.parse(readFileSync(need("plan"), "utf8")).items ?? [];
const email = need("staff-email"), staffId = need("staff-id"), branchId = need("branch-id");

async function token() {
  const requestId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ staffId, email, requestId, issuedAt: now, expiresAt: now + 60 }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded, "ascii").digest("hex");
  const r = await fetch(`${base}/api/v1/admin/auth/service/staff-access-token`, { method: "POST", headers: { "content-type": "application/json", "x-crm-service-token": serviceToken, "x-crm-staff-assertion": `v1.${encoded}.${sig}`, "x-request-id": requestId }, body: JSON.stringify({ email, requestId }) });
  if (!r.ok) throw new Error(`bridge ${r.status}`);
  return (await r.json()).access_token;
}
let bearer = await token();
async function api(method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: r.status, body: json, code: json?.error?.code };
}
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const cat = await api("GET", `/admin/birthday-bookings/catalog?branchId=${encodeURIComponent(branchId)}`);
if (cat.status !== 200) { console.error(`catalog ${cat.status}`); process.exit(1); }
const rooms = cat.body.rooms.filter((r) => r.branchId === branchId), packages = cat.body.packages.filter((p) => p.branchId === branchId);
const byName = (list, name) => list.find((x) => norm(x.name) === norm(name)) ?? list.find((x) => norm(x.name).replace(/ party$/, "") === norm(name).replace(/ party$/, ""));
const hhmm = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

const out = {}; const lines = [];
const note = (item, result) => { out[result] = (out[result] ?? 0) + 1; lines.push(`${item.sourceKey.slice(0, 10)}: ${result}`); };
for (const item of plan) {
  const room = byName(rooms, item.roomName);
  if (!room) { note(item, "room_not_in_catalog"); continue; }
  const pkg = item.kind === "booking" ? byName(packages, item.packageName) : null;
  if (item.kind === "booking" && !pkg) { note(item, "package_not_in_catalog"); continue; }
  const tl = await api("GET", `/admin/birthday-bookings/timeline?branchId=${encodeURIComponent(branchId)}&date=${item.date}`);
  if (tl.status !== 200) { note(item, `timeline_${tl.status}`); continue; }
  const here = tl.body.reservations.filter((r) => r.roomId === room.id && r.status !== "released");
  if (here.some((r) => hhmm(r.startsAt) === item.start && r.kind === (item.kind === "block" ? "block" : "booking"))) { note(item, "already_present"); continue; }
  const s = Date.parse(`${item.date}T${item.start}:00+05:00`), e = s + 240 * 60_000;
  if (here.some((r) => Date.parse(r.startsAt) < e && s < Date.parse(r.occupiedEndsAt))) { note(item, "conflict_needs_manager"); continue; }
  if (!apply) { note(item, "would_create"); continue; }
  if (item.kind === "block") {
    const r = await api("POST", "/admin/birthday-slots/block", { branchId, bookingDate: item.date, roomId: room.id, startTime: item.start, reason: item.reason, idempotencyKey: `${item.idempotencyKey}:block` });
    note(item, r.status === 200 ? "created" : `refused_${r.code ?? r.status}`);
    continue;
  }
  const req = await api("POST", "/admin/birthday-requests", { branchId, packageId: pkg.id, customerName: item.customerName, phone: item.phone, guestCount: item.guestCount, requestedDate: item.date, notes: item.note, idempotencyKey: `${item.idempotencyKey}:request` });
  if (![200, 201].includes(req.status)) { note(item, `request_${req.code ?? req.status}`); continue; }
  const pay = await api("POST", `/admin/birthday-requests/${req.body.id}/manual-payments`, { amountKzt: item.prepaymentKzt, method: item.prepaymentMethod, idempotencyKey: `${item.idempotencyKey}:payment`, note: "Импорт из журнала: сумма проверена менеджером" });
  if (pay.status !== 200) { note(item, `payment_${pay.code ?? pay.status}`); continue; }
  const conf = await api("POST", "/admin/birthday-bookings/confirm", { requestId: req.body.id, bookingDate: item.date, roomId: room.id, startTime: item.start, packageId: pkg.id, agreedPriceKzt: item.agreedPriceKzt, idempotencyKey: `${item.idempotencyKey}:confirm`, note: item.note });
  // A refused confirmation leaves a paid, unconfirmed request in the CRM: report it so a manager confirms it on another time.
  note(item, conf.status === 200 ? "created" : `paid_request_left_unconfirmed_${conf.code ?? conf.status}`);
}
console.log(JSON.stringify({ target, mode: apply ? "apply" : "dry-run", items: plan.length, results: out }, null, 1));
console.log(lines.join("\n"));
