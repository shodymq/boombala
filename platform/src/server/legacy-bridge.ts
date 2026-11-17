import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { completeMfaLogin, authenticate } from "../core/auth.ts";
import { attendanceSeries, addManualEntry, confirmRegistrationEntry, correctEntry, dayFigures, listEntries, searchRegistrations } from "../core/attendance.ts";
import { catalogSummary, listPackages, listRooms, listSlots, resolvePrice } from "../core/catalog.ts";
import type { Pool } from "../core/db.ts";
import { withTx } from "../core/db.ts";
import { isValidDate } from "../core/dates.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors.ts";
import { beginEnrollment, isEnrolled } from "../core/mfa.ts";
import { outboxStats } from "../core/outbox.ts";
import { getPublished, listDocuments, createDraft, updateDraft, approveDocument, publishDocument, retireDocument, LEGAL_KINDS } from "../core/legal.ts";
import { can, type Actor } from "../core/rbac.ts";
import { validateSession, type ValidSession } from "../core/session.ts";
import { listLeads, setLeadStatus } from "../core/bookings.ts";
import { getContact, listContacts } from "../core/crm.ts";
import { assessContact, anonymizeContact, revokeConsent, retentionReport } from "../core/privacy.ts";
import { getPost, listImages, listPosts, createPost, updatePost, publishPost, unpublishPost, deletePost, deleteImage, type PostInput } from "../core/news.ts";
import { createUser, listUsers, changeRole, setActive, setCanExport, setPassword } from "../core/users.ts";
import { listEnrolledUserIds, resetUserMfa } from "../core/mfa.ts";
import { nameKey } from "../core/phone.ts";
import { attendanceSchemaReady } from "../core/preflight.ts";
import { writeAudit } from "../core/audit.ts";
import { mfaRequired, mfaKey } from "./env.ts";
import { getPool } from "./db.ts";
import { requestMeta } from "./request.ts";

const MAX_BODY_BYTES = 128 * 1024;

function serviceToken(): string {
  const value = (process.env.CRM_SERVICE_TOKEN ?? "").trim();
  if (value.length < 32) throw new BridgeHttpError(503, "bridge_not_configured");
  return value;
}

export class BridgeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "BridgeHttpError";
    this.status = status;
    this.code = code;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertBridgeService(request: Request): void {
  const supplied = request.headers.get("x-crm-service-token") ?? "";
  if (!constantTimeEquals(supplied, serviceToken())) throw new BridgeHttpError(401, "bridge_unauthorized");
}

export function jsonError(error: unknown): Response {
  if (error instanceof BridgeHttpError) return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ValidationError) return Response.json({ error: "invalid" }, { status: 422, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (error instanceof NotFoundError) return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ConflictError) return Response.json({ error: error.message }, { status: 409, headers: { "Cache-Control": "no-store" } });
  console.error("[legacy-bridge] internal error", error instanceof Error ? error.name : "non-error");
  return Response.json({ error: "bridge_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new BridgeHttpError(413, "body_too_large");
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeHttpError(422, "invalid_body");
  return body as Record<string, unknown>;
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization") ?? "";
  return /^Bearer [A-Za-z0-9._~-]{20,200}$/.test(value) ? value.slice(7) : undefined;
}

export async function bridgeSession(request: Request, state: "verified" | "pending" = "verified"): Promise<{ token: string; session: ValidSession }> {
  const token = bearer(request);
  const session = await validateSession(getPool(), token, { state, requireMfa: state === "verified" && mfaRequired });
  if (!token || !session) throw new BridgeHttpError(401, "session_invalid");
  return { token, session };
}

export async function bridgeLogin(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const body = await readJson(request);
    const meta = await requestMeta();
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = await authenticate(getPool(), { email, password, mfaRequired: body.mfaRequired === true, ip: typeof body.ip === "string" ? body.ip : meta.ip, userAgent: typeof body.userAgent === "string" ? body.userAgent : meta.userAgent });
    return Response.json({ ...result, ...(result.ok ? { expiresAt: result.expiresAt.toISOString() } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function bridgeMfa(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const body = await readJson(request);
    const meta = await requestMeta();
    const result = await completeMfaLogin(getPool(), { pendingToken: typeof body.pendingToken === "string" ? body.pendingToken : undefined, code: typeof body.code === "string" ? body.code : "", mfaKey, ip: typeof body.ip === "string" ? body.ip : meta.ip, userAgent: typeof body.userAgent === "string" ? body.userAgent : meta.userAgent });
    return Response.json({ ...result, ...(result.ok ? { expiresAt: result.expiresAt.toISOString() } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function bridgeSessionResponse(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const state = new URL(request.url).searchParams.get("state") === "pending" ? "pending" : "verified";
    const result = await bridgeSession(request, state);
    return Response.json({ session: result.session }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BridgeHttpError && error.code === "session_invalid") return Response.json({ session: null }, { headers: { "Cache-Control": "no-store" } });
    return jsonError(error);
  }
}

export async function bridgeEnrollment(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const { session } = await bridgeSession(request, "pending");
    const enrolled = await isEnrolled(getPool(), session.user.id);
    if (enrolled) return Response.json({ enrolled: true }, { headers: { "Cache-Control": "no-store" } });
    const enrollment = await beginEnrollment(getPool(), session.user.id, mfaKey);
    return Response.json({ enrolled: false, ...enrollment }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function bridgeLogout(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const { token } = await bridgeSession(request);
    await (await import("../core/session.ts")).revokeSession(getPool(), token);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function bridgeHealth(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    await getPool().query("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError({ body: "invalid" });
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new ValidationError({ value: "invalid" });
  return value.trim();
}
function optionalText(value: unknown, max = 300): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, max);
}
function actorOf(session: ValidSession): Actor {
  return { id: session.user.id, role: session.user.role };
}
function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function uuidFromKey(value: string): string {
  const hex = createHash("sha256").update(`boombala-idempotency:${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | Number.parseInt(hex.slice(16, 17), 16) % 4).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
function parseDate(value: unknown): string {
  const date = text(value, 10);
  if (!isValidDate(date)) throw new ValidationError({ date: "invalid" });
  return date;
}
function parseTime(value: unknown): string {
  const timeValue = text(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeValue)) throw new ValidationError({ startTime: "invalid" });
  return timeValue;
}
function almatyInterval(date: string, start: string): { startSql: string; endSql: string } {
  // Asia/Almaty is UTC+05:00. Keep the conversion explicit so the bridge
  // does not depend on the Vercel function's host timezone.
  const end = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(start.slice(0, 2)) - 5, Number(start.slice(3, 5))));
  const startDate = end.toISOString();
  const endDate = new Date(end.getTime() + 4 * 60 * 60 * 1000).toISOString();
  return { startSql: startDate, endSql: endDate };
}
function ensureWorkingHours(start: string): void {
  const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  if (minutes < 600 || minutes > 1080) throw new ValidationError({ startTime: "outside_working_hours" });
}

async function dashboard(pool: Pool, session: ValidSession) {
  const actor = actorOf(session);
  const [migrations, summary, outbox, ready] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name DESC"),
    can(session.user.role, "catalog.view") ? catalogSummary(pool) : Promise.resolve(null),
    can(session.user.role, "contacts.view") ? outboxStats(pool) : Promise.resolve(null),
    can(session.user.role, "attendance.manage") ? attendanceSchemaReady(pool) : Promise.resolve(false),
  ]);
  return { migrations: migrations.rows.map((r) => r.name), summary, outbox, attendance: ready && can(session.user.role, "attendance.manage") ? await dayFigures(pool, actor, (await import("../core/dates.ts")).almatyToday()) : null };
}

async function bookingCatalog(pool: Pool) {
  const summary = await catalogSummary(pool);
  const [packages, rooms] = [summary.packages, summary.rooms];
  const branch = { id: "almaty", slug: "almaty", name: "Boom Bala Алматы", city: "Алматы", workingHours: "10:00-22:00", bufferMinutes: 0 };
  return { branches: [branch], rooms: rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, branchId: "almaty", name: r.name })), packages: packages.filter((p) => p.isActive).map((p) => ({ id: p.id, branchId: "almaty", name: p.name, priceFrom: p.basePrice ?? 0, priceLabel: p.basePrice == null ? "" : `${p.basePrice} ₸`, guestCapacityLabel: "" })) };
}

async function bookingTimeline(pool: Pool, date: string) {
  const rooms = await pool.query<{ id: string; name: string }>("SELECT id, name FROM bb.rooms WHERE is_active ORDER BY sort_order, id");
  const rows = await pool.query<{ id: string; kind: "booking" | "block"; room_id: string; starts_at: string; ends_at: string; slot_id: number | null; package_name: string | null; price_kzt: number | null; price_source: string | null; note: string | null; lead_request_id: string | null; customer_name: string | null; customer_phone: string | null; created_by: string | null; created_by_name: string | null; released_at: string | null; paid_kzt: number | null }>(
    `SELECT r.id, r.kind, r.room_id, r.starts_at, r.ends_at, r.slot_id, p.name package_name, r.price_kzt, r.price_source, r.note,
            r.lead_request_id, c.name customer_name, c.phone_e164 customer_phone, r.created_by, u.name created_by_name, r.released_at,
            (SELECT amount_kzt FROM bb.manual_payment_facts f WHERE f.lead_request_id=r.lead_request_id) paid_kzt
       FROM bb.slot_reservations r LEFT JOIN bb.packages p ON p.id=r.package_id LEFT JOIN bb.contacts c ON c.id=r.contact_id
       LEFT JOIN bb.users u ON u.id=r.created_by WHERE r.slot_date=$1 ORDER BY r.starts_at`, [date]);
  return { branchId: "almaty", date, timezone: "Asia/Almaty", bufferMinutes: 0, rooms: rooms.rows, reservations: rows.rows.map((r) => ({ id: r.id, kind: r.kind, status: r.released_at ? "released" : r.kind === "block" ? "blocked" : "confirmed", roomId: r.room_id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), occupiedEndsAt: new Date(r.ends_at).toISOString(), slotId: r.slot_id == null ? null : String(r.slot_id), packageName: r.package_name, priceKzt: r.price_kzt, priceSource: r.price_source, paidKzt: r.paid_kzt ?? 0, paymentStatus: r.paid_kzt ? "prepaid" : "unpaid", note: r.note, requestId: r.lead_request_id, customerName: r.customer_name, customerPhone: r.customer_phone, createdByAdminId: r.created_by, createdByName: r.created_by_name, releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null })) };
}

async function ensureIdempotent<T>(pool: Pool, actor: Actor, key: string, operation: string, input: unknown, run: (tx: import("../core/db.ts").Client) => Promise<T>): Promise<T> {
  const requestHash = hashInput(input);
  return withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`bridge-idempotency:${key}`]);
    const found = await tx.query<{ request_hash: string; result: T }>("SELECT request_hash, result FROM bb.booking_operations WHERE idempotency_key=$1 FOR UPDATE", [key]);
    if (found.rows[0]) {
      if (found.rows[0].request_hash !== requestHash) throw new ConflictError("idempotency_conflict");
      return found.rows[0].result;
    }
    const result = await run(tx);
    await tx.query("INSERT INTO bb.booking_operations (idempotency_key, operation_name, request_hash, result, created_by) VALUES ($1,$2,$3,$4,$5)", [key, operation, requestHash, JSON.stringify(result), actor.id]);
    return result;
  });
}

async function bridgeCreateRequest(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const key = text(input.idempotencyKey, 200);
  const date = parseDate(input.requestedDate);
  const name = text(input.customerName, 120);
  const phone = text(input.phone, 20);
  const packageId = text(input.packageId, 120);
  const guestCount = input.guestCount === undefined || input.guestCount === null || input.guestCount === "" ? null : input.guestCount;
  if (guestCount !== null && (typeof guestCount !== "number" || !Number.isInteger(guestCount) || guestCount < 0 || guestCount > 200)) throw new ValidationError({ guestCount: "invalid" });
  return ensureIdempotent(pool, actor, key, "request", input, async (tx) => {
    const packageRow = await tx.query("SELECT 1 FROM bb.packages WHERE id=$1 AND is_active", [packageId]);
    if (!packageRow.rows[0]) throw new ValidationError({ packageId: "invalid" });
    const existing = await tx.query<{ id: string; status: string; branch_id: string; package_id: string | null; requested_date: string; children: number | null }>("SELECT id,status,package_id,to_char(requested_date,'YYYY-MM-DD') requested_date,children FROM bb.lead_requests WHERE idempotency_key=$1", [uuidFromKey(key)]);
    if (existing.rows[0]) return { id: existing.rows[0].id, status: existing.rows[0].status, branchId: "almaty", packageId: existing.rows[0].package_id, requestedDate: existing.rows[0].requested_date, guestCount: existing.rows[0].children, source: "manual" };
    const contact = await tx.query<{ id: string }>("INSERT INTO bb.contacts (name,name_key,phone_e164,source) VALUES ($1,$2,$3,'manual') ON CONFLICT (phone_e164,name_key) DO UPDATE SET last_activity_at=now() RETURNING id", [name, nameKey(name), phone]);
    const lead = await tx.query<{ id: string; status: string; package_id: string | null; requested_date: string; children: number | null }>("INSERT INTO bb.lead_requests (idempotency_key,contact_id,package_id,requested_date,children,status) VALUES ($1,$2,$3,$4,$5,'new') RETURNING id,status,package_id,to_char(requested_date,'YYYY-MM-DD') requested_date,children", [uuidFromKey(key), contact.rows[0].id, packageId, date, guestCount]);
    await tx.query("INSERT INTO bb.outbox (topic,ref_id) VALUES ('telegram.lead',$1) ON CONFLICT DO NOTHING", [lead.rows[0].id]);
    return { id: lead.rows[0].id, status: lead.rows[0].status, branchId: "almaty", packageId: lead.rows[0].package_id, requestedDate: lead.rows[0].requested_date, guestCount: lead.rows[0].children, source: "manual" };
  });
}

async function bridgePayment(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const requestId = text(input.requestId, 80);
  const key = text(input.idempotencyKey, 200);
  const amount = Number(input.amountKzt);
  if (!Number.isInteger(amount) || amount !== 10000) throw new ValidationError({ amountKzt: "Предоплата должна быть 10 000 ₸" });
  const method = text(input.method, 30);
  if (!["cash", "card_terminal", "bank_transfer", "other_manual"].includes(method)) throw new ValidationError({ method: "invalid" });
  return ensureIdempotent(pool, actor, key, "payment", input, async (tx) => {
    const lead = await tx.query("SELECT id,status FROM bb.lead_requests WHERE id=$1 FOR UPDATE", [requestId]);
    if (!lead.rows[0]) throw new NotFoundError();
    const existing = await tx.query<{ id: string; amount_kzt: number; payment_method: string }>("SELECT id,amount_kzt,payment_method FROM bb.manual_payment_facts WHERE lead_request_id=$1 FOR UPDATE", [requestId]);
    if (existing.rows[0]) {
      if (existing.rows[0].amount_kzt !== amount || existing.rows[0].payment_method !== method) throw new ConflictError("idempotency_conflict");
      return { id: existing.rows[0].id, amountKzt: existing.rows[0].amount_kzt, method: existing.rows[0].payment_method, status: "prepaid" };
    }
    const saved = await tx.query<{ id: string; amount_kzt: number; payment_method: string }>("INSERT INTO bb.manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,note,recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,amount_kzt,payment_method", [requestId, amount, method, key, optionalText(input.note), actor.id]);
    return { id: saved.rows[0].id, amountKzt: saved.rows[0].amount_kzt, method: saved.rows[0].payment_method, status: "prepaid" };
  });
}

async function bridgeReschedule(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError(); const key = text(input.idempotencyKey, 200); const id = text(input.reservationId, 80); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120);
  return ensureIdempotent(pool, actor, key, "reschedule", input, async (tx) => {
    const old = await tx.query<{ kind: "booking" | "block"; room_id: string; lead_request_id: string | null; contact_id: string | null; package_id: string | null; children: number | null; price_kzt: number | null; price_source: string | null; note: string | null }>("SELECT kind,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,note FROM bb.slot_reservations WHERE id=$1 AND released_at IS NULL FOR UPDATE", [id]);
    if (!old.rows[0]) throw new NotFoundError();
    const { startSql, endSql } = almatyInterval(date, start);
    await tx.query("UPDATE bb.slot_reservations SET released_at=now(),released_by=$2,release_reason='rescheduled' WHERE id=$1", [id, actor.id]);
    const next = await tx.query<{ id: string }>("INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,note,created_by,starts_at,ends_at) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id", [old.rows[0].kind, date, roomId, old.rows[0].lead_request_id, old.rows[0].contact_id, old.rows[0].package_id, old.rows[0].children, old.rows[0].price_kzt, old.rows[0].price_source, old.rows[0].note, actor.id, startSql, endSql]);
    if (old.rows[0].lead_request_id) await tx.query("UPDATE bb.lead_requests SET requested_date=$2,room_id=$3 WHERE id=$1", [old.rows[0].lead_request_id, date, roomId]);
    await writeAudit(tx, { actorUserId: actor.id, action: "booking.rescheduled", entityType: "slot_reservation", entityId: next.rows[0].id, after: { previousReservationId: id, date, roomId, start }, ...(await requestMeta()) });
    return { id: next.rows[0].id, status: "confirmed" };
  });
}

async function bridgeConfirm(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const leadId = text(input.requestId, 80); const key = text(input.idempotencyKey, 200); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120); const packageId = text(input.packageId, 120);
  return ensureIdempotent(pool, actor, key, "confirm", input, async (tx) => {
    const lead = await tx.query<{ id: string; status: string; contact_id: string; children: number | null }>("SELECT id,status,contact_id,children FROM bb.lead_requests WHERE id=$1 FOR UPDATE", [leadId]);
    if (!lead.rows[0]) throw new NotFoundError();
    if (!["new", "in_progress"].includes(lead.rows[0].status)) throw new ConflictError("birthday_request_not_bookable");
    const paid = await tx.query("SELECT 1 FROM bb.manual_payment_facts WHERE lead_request_id=$1 AND amount_kzt=10000", [leadId]);
    if (!paid.rows[0]) throw new ValidationError({ payment: "birthday_prepayment_required" });
    const room = await tx.query("SELECT 1 FROM bb.rooms WHERE id=$1 AND is_active", [roomId]); if (!room.rows[0]) throw new ValidationError({ roomId: "invalid" });
    const pkg = await tx.query("SELECT 1 FROM bb.packages WHERE id=$1 AND is_active", [packageId]); if (!pkg.rows[0]) throw new ValidationError({ packageId: "invalid" });
    const price = await resolvePrice(tx, packageId, date); if (!price) throw new ValidationError({ packageId: "no_price" });
    const { startSql, endSql } = almatyInterval(date, start);
    const reservation = await tx.query<{ id: string }>("INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,note,created_by,starts_at,ends_at) VALUES ('booking',$1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id", [date, roomId, leadId, lead.rows[0].contact_id, packageId, lead.rows[0].children, Number(input.agreedPriceKzt) || price.amountKzt, "manager_agreed", optionalText(input.note), actor.id, startSql, endSql]);
    await tx.query("UPDATE bb.lead_requests SET status='confirmed',requested_date=$2,room_id=$3,package_id=$4 WHERE id=$1", [leadId, date, roomId, packageId]);
    await writeAudit(tx, { actorUserId: actor.id, action: "booking.confirmed", entityType: "slot_reservation", entityId: reservation.rows[0].id, after: { leadId, date, roomId, start, packageId }, ...(await requestMeta()) });
    return { id: reservation.rows[0].id, status: "confirmed" };
  });
}

async function bridgeBlock(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError(); const key = text(input.idempotencyKey, 200); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120); const { startSql, endSql } = almatyInterval(date, start);
  return ensureIdempotent(pool, actor, key, "block", input, async (tx) => {
    const row = await tx.query<{ id: string }>("INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block',$1,NULL,$2,$3,$4,$5,$6) RETURNING id", [date, roomId, text(input.reason, 300), actor.id, startSql, endSql]);
    return { id: row.rows[0].id, status: "blocked" };
  });
}

async function bridgeRelease(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError(); const key = text(input.idempotencyKey, 200); const id = text(input.reservationId, 80);
  return ensureIdempotent(pool, actor, key, "release", input, async (tx) => {
    const row = await tx.query<{ kind: string; lead_request_id: string | null }>("UPDATE bb.slot_reservations SET released_at=now(),released_by=$2,release_reason=$3 WHERE id=$1 AND released_at IS NULL RETURNING kind,lead_request_id", [id, actor.id, optionalText(input.reason)]);
    if (!row.rows[0]) throw new ConflictError("reservation_already_released");
    if (row.rows[0].lead_request_id) await tx.query("UPDATE bb.lead_requests SET status='cancelled' WHERE id=$1 AND status='confirmed'", [row.rows[0].lead_request_id]);
    await writeAudit(tx, { actorUserId: actor.id, action: row.rows[0].kind === "block" ? "block.released" : "booking.cancelled", entityType: "slot_reservation", entityId: id, after: { reason: optionalText(input.reason) }, ...(await requestMeta()) });
    return { id, status: "released" };
  });
}

export async function bridgeRpc(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const { session } = await bridgeSession(request);
    const body = await readJson(request);
    const op = text(body.op, 80);
    const input = record(body.input ?? {});
    const pool = getPool(); const actor = actorOf(session);
    switch (op) {
      case "dashboard": return Response.json(await dashboard(pool, session), { headers: { "Cache-Control": "no-store" } });
      case "requests.list": return Response.json(await listLeads(pool, actor, typeof input.status === "string" ? { status: input.status } : {}), { headers: { "Cache-Control": "no-store" } });
      case "requests.status": await setLeadStatus(pool, actor, text(input.id, 80), text(input.status, 30) as "new" | "in_progress" | "cancelled", await requestMeta()); return Response.json({ ok: true });
      // The legacy slot-confirmation writer is deliberately unavailable in bridge mode.
      // Booking confirmation must go through payment -> interval reservation -> read-after-write.
      case "requests.confirm": throw new ConflictError("use_calendar_flow");
      case "catalog": return Response.json({ packages: await listPackages(pool), rooms: await listRooms(pool), slots: await listSlots(pool) });
      case "calendar.catalog": return Response.json(await bookingCatalog(pool), { headers: { "Cache-Control": "no-store" } });
      case "calendar.timeline": return Response.json(await bookingTimeline(pool, parseDate(input.date)), { headers: { "Cache-Control": "no-store" } });
      case "calendar.leads": { const leads = await listLeads(pool, actor, {}); return Response.json({ items: leads.map((l) => ({ id: l.id, type: "birthday_request", status: l.status, phone: l.phone, customerName: l.name, createdAt: l.createdAt.toISOString(), requestedDate: l.requestedDate, branch: { id: "almaty" } })), total: leads.length }); }
      case "calendar.lead": { const row = await pool.query<{ id: string; status: string; booked_at: string | null; name: string; payment_amount: number | null }>("SELECT l.id,l.status,r.created_at booked_at,c.name,(SELECT amount_kzt FROM bb.manual_payment_facts p WHERE p.lead_request_id=l.id) payment_amount FROM bb.lead_requests l JOIN bb.contacts c ON c.id=l.contact_id LEFT JOIN bb.slot_reservations r ON r.lead_request_id=l.id AND r.released_at IS NULL WHERE l.id=$1", [text(input.id, 80)]); const x = row.rows[0]; if (!x) throw new NotFoundError(); return Response.json({ id: x.id, status: x.status, bookedAt: x.booked_at, manualPaymentFactStatus: x.payment_amount ? "prepaid" : "unpaid", manualPaymentFactAmountKzt: x.payment_amount ?? 0, customerName: x.name }); }
      case "booking.request": return Response.json(await bridgeCreateRequest(pool, session, input));
      case "booking.payment": return Response.json(await bridgePayment(pool, session, input));
      case "booking.confirm": return Response.json(await bridgeConfirm(pool, session, input));
      case "booking.block": return Response.json(await bridgeBlock(pool, session, input));
      case "booking.reschedule": return Response.json(await bridgeReschedule(pool, session, input));
      case "booking.release": return Response.json(await bridgeRelease(pool, session, input));
      case "attendance.view": { const date = parseDate(input.date); const saved = await searchRegistrations(pool, actor, date, { q: typeof input.q === "string" ? input.q : "", filter: input.filter as "waiting" | "confirmed" | "all", limit: Number(input.limit) || 50 }); return Response.json({ figures: await dayFigures(pool, actor, date), found: saved, entries: await listEntries(pool, actor, date), series: await attendanceSeries(pool, actor, typeof input.from === "string" ? input.from : date, typeof input.to === "string" ? input.to : date), ready: await attendanceSchemaReady(pool) }); }
      case "attendance.confirm": return Response.json(await confirmRegistrationEntry(pool, actor, { registrationId: text(input.registrationId, 80), childrenCount: Number(input.childrenCount), onDate: parseDate(input.onDate) }, await requestMeta()));
      case "attendance.manual": return Response.json(await addManualEntry(pool, actor, { childrenCount: Number(input.childrenCount), idempotencyKey: text(input.idempotencyKey, 120), onDate: parseDate(input.onDate) }, await requestMeta()));
      case "attendance.correct": return Response.json(await correctEntry(pool, actor, { entryId: text(input.entryId, 80), newCount: Number(input.newCount), expectedCount: Number(input.expectedCount), reason: text(input.reason, 80) }, await requestMeta()));
      case "contacts.list": return Response.json(await listContacts(pool, actor, input.filters as never, Number(input.page) || 1));
      case "contacts.get": return Response.json(await getContact(pool, actor, text(input.id, 80)));
      case "privacy.assess": return Response.json(await assessContact(pool, actor, text(input.id, 80)));
      case "retention.report": return Response.json(await retentionReport(pool, actor));
      case "legal.published": return Response.json(await getPublished(pool));
      case "legal.list": return Response.json(await listDocuments(pool, actor));
      case "news.list": return Response.json(await listPosts(pool, actor, { status: typeof input.status === "string" ? input.status as never : undefined }));
      case "news.get": return Response.json(await getPost(pool, actor, text(input.id, 80)));
      case "news.images": return Response.json(await listImages(pool, actor));
      case "users.list": return Response.json({ users: await listUsers(pool, actor), enrolled: [...await listEnrolledUserIds(pool, actor)] });
      case "contacts.revoke": return Response.json(await revokeConsent(pool, actor, text(input.id, 80), await requestMeta()));
      case "contacts.anonymize": return Response.json(await anonymizeContact(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.create": {
        const kind = text(input.kind, 80);
        if (!(LEGAL_KINDS as readonly string[]).includes(kind)) throw new ValidationError({ kind: "invalid" });
        return Response.json(await createDraft(pool, actor, { kind: kind as never, title: text(input.title, 200), body: text(input.body, 100000) }, await requestMeta()));
      }
      case "legal.update": return Response.json(await updateDraft(pool, actor, text(input.id, 80), { title: text(input.title, 200), body: text(input.body, 100000) }, await requestMeta()));
      case "legal.approve": return Response.json(await approveDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.publish": return Response.json(await publishDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "legal.retire": return Response.json(await retireDocument(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.create": return Response.json(await createPost(pool, actor, input as unknown as PostInput, await requestMeta()));
      case "news.update": return Response.json(await updatePost(pool, actor, text(input.id, 80), input as unknown as PostInput, await requestMeta()));
      case "news.publish": return Response.json(await publishPost(pool, actor, text(input.id, 80), input.publishAt ? new Date(text(input.publishAt, 40)) : null, await requestMeta()));
      case "news.unpublish": return Response.json(await unpublishPost(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.delete": return Response.json(await deletePost(pool, actor, text(input.id, 80), await requestMeta()));
      case "news.deleteImage": return Response.json(await deleteImage(pool, actor, text(input.id, 80), await requestMeta()));
      case "users.create": return Response.json(await createUser(pool, actor, { email: text(input.email, 254), name: text(input.name, 120), role: text(input.role, 20) as never, password: text(input.password, 128) }, await requestMeta()));
      case "users.role": await changeRole(pool, actor, text(input.id, 80), text(input.role, 20) as never, await requestMeta()); return Response.json({ ok: true });
      case "users.active": await setActive(pool, actor, text(input.id, 80), input.active === true, await requestMeta()); return Response.json({ ok: true });
      case "users.export": await setCanExport(pool, actor, text(input.id, 80), input.allowed === true, await requestMeta()); return Response.json({ ok: true });
      case "users.password": await setPassword(pool, actor, text(input.id, 80), text(input.password, 128), await requestMeta()); return Response.json({ ok: true });
      case "users.resetMfa": await resetUserMfa(pool, actor, text(input.id, 80), await requestMeta()); return Response.json({ ok: true });
      case "audit.list": {
        if (!can(session.user.role, "audit.view")) throw new ForbiddenError();
        const rows = await pool.query<{ id: string; at: Date; action: string; entity_type: string | null; entity_id: string | null; actor: string | null; detail: string | null }>(
          `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, u.name AS actor,
                  left(coalesce(a.after, a.before)::text, 160) AS detail
             FROM bb.audit_log a LEFT JOIN bb.users u ON u.id = a.actor_user_id
            ORDER BY a.id DESC LIMIT 200`,
        );
        return Response.json({ rows: rows.rows.map((row) => ({ ...row, at: row.at.toISOString() })) }, { headers: { "Cache-Control": "no-store" } });
      }
      default: throw new BridgeHttpError(404, "operation_not_allowed");
    }
  } catch (error) {
    return jsonError(error);
  }
}
