// Stateful stand-in for the FastAPI booking endpoints the CRM calendar calls. FOR LOCAL VERIFICATION ONLY: synthetic data, no
// secrets, never deployed. It is NOT the booking kernel; it only mirrors the contract in src/server/fastapi-crm.ts so the UI can
// be exercised end to end (create, conflict, reschedule, release, read-back, role-scoped client data, API failure).
//
//   node e2e/support/mock-fastapi-calendar.mjs            # port 8099, any start minute accepted (the target rule)
//   MOCK_WHOLE_HOURS=1 node ...                           # emulates today's FastAPI: starts must be HH:00 (invalid_start_time)
//   MOCK_FAIL=timeline node ...                           # the timeline endpoint answers 500
// Staff whose e-mail starts with "operator" get a token that hides client name and phone (as FastAPI does for that role).
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8099);
const WHOLE_HOURS = process.env.MOCK_WHOLE_HOURS === "1";
const FAIL = process.env.MOCK_FAIL ?? "";
const DATE = process.env.MOCK_DATE ?? "2026-11-16";
const BRANCH = "br-almaty";
const OPEN = 10 * 60;
const CLOSE = 23 * 60;
const DURATION = 240;

const rooms = ["Roblox Room", "Ice Room", "Magic Room", "Rapunzel Room"].map((name, i) => ({ id: `room-${i + 1}`, branchId: BRANCH, name }));
const packages = [
  { id: "pkg-magic", branchId: BRANCH, name: "Magic Party", priceFrom: 90000, priceLabel: "от 90 000 ₸", guestCapacityLabel: "до 15 гостей" },
  { id: "pkg-wow", branchId: BRANCH, name: "Wow Party", priceFrom: 120000, priceLabel: "от 120 000 ₸", guestCapacityLabel: "до 20 гостей" },
  { id: "pkg-bb", branchId: BRANCH, name: "BoomBala Party", priceFrom: 100000, priceLabel: "от 100 000 ₸", guestCapacityLabel: "до 15 гостей" },
];

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const iso = (date, minutes) => new Date(`${date}T${hhmm(minutes)}:00+05:00`).toISOString();
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const reservations = [];
const requests = new Map();
const payments = new Map();
const idem = new Map();

function addReservation(r) {
  const res = {
    id: `res-${randomUUID().slice(0, 8)}`, kind: "booking", status: "confirmed", slotId: null, priceSource: "manager_agreed", paidKzt: 0, paymentStatus: "unpaid",
    note: null, requestId: null, customerName: null, customerPhone: null, createdByAdminId: "adm-1", createdByName: "Айгерим (менеджер)", releasedAt: null, ...r,
  };
  res.startsAt = iso(res.date, res.start);
  res.endsAt = iso(res.date, res.start + DURATION);
  res.occupiedEndsAt = res.endsAt;
  reservations.push(res);
  return res;
}

function seed() {
  const day = (start, room, rest) => addReservation({ date: DATE, start: toMin(start), roomId: room, ...rest });
  day("13:00", "room-1", { packageName: "Magic Party", priceKzt: 110000, paidKzt: 10000, paymentStatus: "prepaid", customerName: "Ульяна К.", customerPhone: "+77000000000", note: "Дети 10-15 лет" });
  day("13:30", "room-2", { packageName: "BoomBala Party", priceKzt: 130000, paidKzt: 10000, paymentStatus: "prepaid", customerName: "Вероника Э.", customerPhone: "+77010102091" });
  day("17:30", "room-2", { packageName: "Magic Party", priceKzt: 95000, customerName: "Ярослава М.", customerPhone: "+77783674577", note: "Ждём предоплату" });
  day("16:40", "room-3", { packageName: "Wow Party", priceKzt: 150000, paidKzt: 10000, paymentStatus: "prepaid", customerName: "София Б.", customerPhone: "+77176278819" });
  day("10:00", "room-4", { packageName: "Magic Party", priceKzt: 100000, paidKzt: 10000, paymentStatus: "prepaid", customerName: "Таисия Р.", customerPhone: "+77000001122" });
  day("14:00", "room-4", { packageName: "Wow Party", priceKzt: 140000, paidKzt: 10000, paymentStatus: "prepaid", customerName: "Жанар А.", customerPhone: "+77770099798" });
  requests.set("req-seed-1", { id: "req-seed-1", type: "birthday_request", status: "new", phone: "+77011112233", customerName: "Динара С. (заявка с сайта)", createdAt: new Date().toISOString(), requestedDate: DATE, branch: { id: BRANCH }, bookedAt: null });
}
seed();

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const err = (res, status, code) => sendJson(res, status, { error: { code } });
const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(data ? JSON.parse(data) : {}));
});

function publicReservation(r, hide) {
  const { date, start, ...rest } = r;
  void date; void start;
  return hide ? { ...rest, customerName: null, customerPhone: null } : rest;
}

function conflicts(roomId, startMin, date, ignoreId) {
  const s = Date.parse(iso(date, startMin));
  const e = s + DURATION * 60_000;
  return reservations.some((r) => r.id !== ignoreId && r.status !== "released" && r.roomId === roomId && Date.parse(r.startsAt) < e && s < Date.parse(r.occupiedEndsAt));
}

function checkStart(res, startTime) {
  if (!/^\d{2}:\d{2}$/.test(startTime ?? "")) return err(res, 422, "invalid_start_time"), false;
  const m = toMin(startTime);
  if (WHOLE_HOURS && m % 60 !== 0) return err(res, 422, "invalid_start_time"), false;
  if (m < OPEN || m + DURATION > CLOSE) return err(res, 422, "outside_working_hours"), false;
  return true;
}

function once(key, res, produce) {
  if (key && idem.has(key)) return sendJson(res, 200, idem.get(key));
  const out = produce();
  if (key) idem.set(key, out);
  return sendJson(res, 200, out);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const hide = (req.headers.authorization ?? "").includes("operator");
  if (req.method === "POST" && path === "/admin/auth/service/staff-access-token") {
    const body = await readBody(req);
    return sendJson(res, 200, { access_token: `mock-${String(body.email).startsWith("operator") ? "operator" : "sales"}-${randomUUID()}` });
  }
  if (!(req.headers.authorization ?? "").startsWith("Bearer mock-")) return err(res, 401, "unauthorized");
  if (req.method === "GET" && path === "/admin/birthday-bookings/catalog") {
    return sendJson(res, 200, { branches: [{ id: BRANCH, slug: "almaty", name: "Boom Bala Алматы", city: "Алматы", workingHours: "10:00-23:00", bufferMinutes: 0 }], rooms, packages });
  }
  if (req.method === "GET" && path === "/admin/birthday-bookings/timeline") {
    if (FAIL === "timeline") return err(res, 500, "internal_error");
    const date = url.searchParams.get("date");
    return sendJson(res, 200, { branchId: BRANCH, date, timezone: "Asia/Almaty", bufferMinutes: 0, rooms: rooms.map(({ id, name }) => ({ id, name })), reservations: reservations.filter((r) => r.date === date).map((r) => publicReservation(r, hide)) });
  }
  if (req.method === "GET" && path === "/admin/leads") {
    const items = [...requests.values()].map((r) => ({ id: r.id, type: r.type, status: r.status, phone: r.phone, customerName: r.customerName, createdAt: r.createdAt, requestedDate: r.requestedDate, branch: r.branch }));
    return sendJson(res, 200, { items, total: items.length });
  }
  const lead = /^\/admin\/leads\/([^/]+)\/birthday$/.exec(path);
  if (req.method === "GET" && lead) {
    const r = requests.get(lead[1]);
    if (!r) return err(res, 404, "lead_not_found");
    const paid = payments.get(r.id) ?? 0;
    return sendJson(res, 200, { id: r.id, status: r.status, bookedAt: r.bookedAt, manualPaymentFactStatus: paid > 0 ? "prepaid" : "unpaid", manualPaymentFactAmountKzt: paid, customerName: r.customerName });
  }
  if (req.method !== "POST") return err(res, 404, "not_found");
  const body = await readBody(req);
  if (path === "/admin/birthday-requests") {
    return once(body.idempotencyKey, res, () => {
      const id = `req-${randomUUID().slice(0, 8)}`;
      requests.set(id, { id, type: "birthday_request", status: "new", phone: body.phone, customerName: body.customerName, createdAt: new Date().toISOString(), requestedDate: body.requestedDate, branch: { id: body.branchId }, bookedAt: null, note: body.notes ?? null });
      return { id, status: "new", branchId: body.branchId, packageId: body.packageId, requestedDate: body.requestedDate, guestCount: body.guestCount ?? null, source: "staff" };
    });
  }
  const pay = /^\/admin\/birthday-requests\/([^/]+)\/manual-payments$/.exec(path);
  if (pay) {
    return once(body.idempotencyKey, res, () => {
      payments.set(pay[1], (payments.get(pay[1]) ?? 0) + body.amountKzt);
      return { id: `pay-${randomUUID().slice(0, 6)}`, amountKzt: body.amountKzt };
    });
  }
  if (path === "/admin/birthday-bookings/confirm") {
    if (body.idempotencyKey && idem.has(body.idempotencyKey)) return sendJson(res, 200, idem.get(body.idempotencyKey));
    if (!checkStart(res, body.startTime)) return;
    const reqRow = requests.get(body.requestId);
    if (!reqRow) return err(res, 404, "birthday_request_not_found");
    if (!(payments.get(body.requestId) > 0)) return err(res, 409, "birthday_prepayment_required");
    if (conflicts(body.roomId, toMin(body.startTime), body.bookingDate)) return err(res, 409, "time_conflict");
    const pkg = packages.find((p) => p.id === body.packageId);
    const r = addReservation({ date: body.bookingDate, start: toMin(body.startTime), roomId: body.roomId, packageName: pkg?.name ?? null, priceKzt: body.agreedPriceKzt, paidKzt: payments.get(body.requestId), paymentStatus: "prepaid", customerName: reqRow.customerName, customerPhone: reqRow.phone, note: body.note ?? null, requestId: body.requestId });
    reqRow.bookedAt = new Date().toISOString();
    reqRow.status = "booked";
    const out = { id: r.id };
    idem.set(body.idempotencyKey, out);
    return sendJson(res, 200, out);
  }
  if (path === "/admin/birthday-slots/block") {
    if (!checkStart(res, body.startTime)) return;
    if (conflicts(body.roomId, toMin(body.startTime), body.bookingDate)) return err(res, 409, "time_conflict");
    const r = addReservation({ date: body.bookingDate, start: toMin(body.startTime), roomId: body.roomId, kind: "block", status: "blocked", note: body.reason, priceKzt: null, priceSource: null });
    return sendJson(res, 200, { id: r.id });
  }
  const move = /^\/admin\/birthday-reservations\/([^/]+)\/(reschedule|release)$/.exec(path);
  if (move) {
    const r = reservations.find((x) => x.id === move[1]);
    if (!r) return err(res, 404, "reservation_not_found");
    if (r.status === "released") return err(res, 409, "reservation_already_released");
    if (move[2] === "release") {
      r.status = "released";
      r.releasedAt = new Date().toISOString();
      return sendJson(res, 200, { id: r.id });
    }
    if (!checkStart(res, body.startTime)) return;
    if (conflicts(body.roomId, toMin(body.startTime), body.bookingDate, r.id)) return err(res, 409, "time_conflict");
    r.date = body.bookingDate;
    r.start = toMin(body.startTime);
    r.roomId = body.roomId;
    r.startsAt = iso(r.date, r.start);
    r.endsAt = iso(r.date, r.start + DURATION);
    r.occupiedEndsAt = r.endsAt;
    return sendJson(res, 200, { id: r.id });
  }
  return err(res, 404, "not_found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock FastAPI calendar on :${PORT} (whole-hours=${WHOLE_HOURS}, date=${DATE})`));
