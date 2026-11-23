import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { completeMfaLogin, authenticate } from "../core/auth.ts";
import { attendanceSeries, addManualEntry, confirmRegistrationEntry, correctEntry, dayFigures, listEntries, searchRegistrations } from "../core/attendance.ts";
import { catalogSummary, listPackages, listRooms, listSlots, resolvePrice } from "../core/catalog.ts";
import type { Pool } from "../core/db.ts";
import { withTx } from "../core/db.ts";
import { almatyToday, isValidDate } from "../core/dates.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors.ts";
import { beginEnrollment, isEnrolled } from "../core/mfa.ts";
import { outboxStats } from "../core/outbox.ts";
import { getPublished, listDocuments, createDraft, updateDraft, approveDocument, publishDocument, retireDocument, LEGAL_KINDS } from "../core/legal.ts";
import { can, canExport, type Actor } from "../core/rbac.ts";
import { exportContacts, type ExportFormat } from "../core/export.ts";
import { MAX_UPLOAD_BYTES } from "../core/images.ts";
import { validateSession, type ValidSession } from "../core/session.ts";
import { listLeads, setLeadStatus } from "../core/bookings.ts";
import { dashboardCounters, getLead, searchLeads, type LeadFilter } from "../core/lead-queue.ts";
import { dashboardAnalytics } from "../core/analytics.ts";
import { managerWorkspace } from "../core/manager-workspace.ts";
import { claimLead, getLeadWorkflowContext, updateLeadWorkflow } from "../core/lead-workflow.ts";
import { getContact, listContacts } from "../core/crm.ts";
import { assessContact, anonymizeContact, revokeConsent, retentionReport } from "../core/privacy.ts";
import { adminImage, addImage, getPost, listImages, listPosts, createPost, updatePost, publishPost, unpublishPost, deletePost, deleteImage, type PostInput } from "../core/news.ts";
import { changeOwnPassword, createUser, listUsers, changeRole, setActive, setCanExport, setPassword } from "../core/users.ts";
import { listEnrolledUserIds, resetUserMfa } from "../core/mfa.ts";
import { nameKey } from "../core/phone.ts";
import { attendanceSchemaReady } from "../core/preflight.ts";
import { writeAudit } from "../core/audit.ts";
import { ensureCard, followReschedule, getCardView, handoverSheetRecord, parseCardPatch, recordCancellation, recordPrepayment, saveCard } from "../core/booking-card.ts";
import { mfaRequired, mfaKey } from "./env.ts";
import { getPool } from "./db.ts";
import { requestMeta } from "./request.ts";
import { runWithPerf } from "../core/perf.ts";
import type { RawRow } from "../core/sheets-import/types.ts";

const MAX_BODY_BYTES = 128 * 1024;

type SheetSyncRecordInput = {
  sourceKey: string;
  fingerprint: string;
  legacyKeyPrefix: string;
  sourceRowNumber: number;
  sourcePayload: RawRow;
};

function validateSheetSyncRecord(value: SheetSyncRecordInput): SheetSyncRecordInput {
  const allowedPayloadFields = new Set(["date", "time", "package", "animator", "room", "client", "phone", "child", "age", "prepayment", "children", "adults", "comment"]);
  if (!/^[0-9a-f]{64}$/.test(value.sourceKey) || !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
      !/^[0-9a-f]{20}$/.test(value.legacyKeyPrefix) || !Number.isSafeInteger(value.sourceRowNumber) || value.sourceRowNumber < 3 ||
      !value.sourcePayload || typeof value.sourcePayload !== "object" || Array.isArray(value.sourcePayload) ||
      Object.entries(value.sourcePayload).some(([key, cell]) => !allowedPayloadFields.has(key) || typeof cell !== "string" || cell.length > 1000)) {
    throw new ValidationError({ source: "invalid_sheet_sync_record" });
  }
  return value;
}

async function persistSheetSyncRecord(tx: import("../core/db.ts").Client, record: SheetSyncRecordInput, reservationId: string): Promise<void> {
  await tx.query(
    `INSERT INTO bb.sheet_sync_records (source_key,fingerprint,legacy_key_prefix,reservation_id,state,source_row_number,source_payload,last_seen_at,missing_since,updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6::jsonb,now(),NULL,now())
     ON CONFLICT (source_key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,legacy_key_prefix=EXCLUDED.legacy_key_prefix,
       reservation_id=EXCLUDED.reservation_id,state='active',safe_review_code=NULL,source_row_number=EXCLUDED.source_row_number,
       source_payload=EXCLUDED.source_payload,last_seen_at=now(),missing_since=NULL,updated_at=now()`,
    [record.sourceKey, record.fingerprint, record.legacyKeyPrefix, reservationId, record.sourceRowNumber, JSON.stringify(record.sourcePayload)],
  );
}

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
    const result = await authenticate(getPool(), { email, password, mfaRequired: body.mfaRequired === true, rememberDevice: body.rememberDevice === true, ip: typeof body.ip === "string" ? body.ip : meta.ip, userAgent: typeof body.userAgent === "string" ? body.userAgent : meta.userAgent });
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
    const started = performance.now();
    const { result, perf } = await runWithPerf(() => bridgeSession(request, state));
    const timing = `handler;dur=${(performance.now() - started).toFixed(1)}, db;dur=${perf.dbMs.toFixed(1)};desc="${perf.queries} queries"`;
    if (process.env.CRM_PERF_LOG === "1") console.info(`[bridge-perf] op=auth.session ${timing}`);
    return Response.json({ session: result.session }, { headers: { "Cache-Control": "no-store", "Server-Timing": timing } });
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

/** The export is generated on the VPS and streamed to the already-authorized browser session. */
export async function bridgeContactExport(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const { session } = await bridgeSession(request);
    if (!canExport(session.user)) throw new ForbiddenError();
    const input = await readJson(request);
    const columns = input.columns;
    if (columns !== undefined && (!Array.isArray(columns) || columns.some((value) => typeof value !== "string"))) {
      throw new ValidationError({ columns: "invalid" });
    }
    const filters = input.filters === undefined ? {} : record(input.filters);
    const result = await exportContacts(
      getPool(),
      { id: session.user.id, role: session.user.role, canExport: session.user.canExport },
      {
        format: text(input.format, 8) as ExportFormat,
        columns: columns as string[] | undefined,
        from: typeof input.from === "string" ? input.from : undefined,
        to: typeof input.to === "string" ? input.to : undefined,
        filters: {
          q: typeof filters.q === "string" ? filters.q : undefined,
          source: typeof filters.source === "string" ? filters.source as never : undefined,
          verification: typeof filters.verification === "string" ? filters.verification as never : undefined,
        },
      },
      await requestMeta(),
    );
    return new Response(new Uint8Array(result.body), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Accepts only authenticated staff uploads; core image processing validates and strips metadata on the VPS. */
export async function bridgeImageUpload(request: NextRequest): Promise<Response> {
  try {
    assertBridgeService(request);
    const { session } = await bridgeSession(request);
    if (!can(session.user.role, "news.manage")) throw new ForbiddenError();
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
      throw new BridgeHttpError(413, "body_too_large");
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError({ file: "invalid" });
    const result = await addImage(
      getPool(),
      actorOf(session),
      Buffer.from(await file.arrayBuffer()),
      typeof form.get("alt") === "string" ? String(form.get("alt")) : "",
      await requestMeta(),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

/** Serves private draft media only to an authenticated staff member with news permission. */
export async function bridgeAdminImage(request: NextRequest, id: string): Promise<Response> {
  try {
    assertBridgeService(request);
    const { session } = await bridgeSession(request);
    if (!can(session.user.role, "news.manage")) throw new ForbiddenError();
    const image = await adminImage(getPool(), actorOf(session), id);
    if (!image) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(new Uint8Array(image.data), {
      headers: { "Content-Type": image.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Typed filter of the request queue: only known keys with the expected types reach the query. */
function leadFilter(input: Record<string, unknown>): LeadFilter {
  const optional = (value: unknown, max: number) => (typeof value === "string" && value !== "" ? text(value, max) : undefined);
  return {
    status: optional(input.status, 30),
    q: optional(input.q, 80),
    createdFrom: optional(input.createdFrom, 10),
    createdTo: optional(input.createdTo, 10),
    overdue: input.overdue === true,
    page: typeof input.page === "number" ? input.page : undefined,
    pageSize: typeof input.pageSize === "number" ? input.pageSize : undefined,
  };
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
  // Every read is independent, so they run together; the attendance figures follow only when the schema check passed.
  const attendance = can(session.user.role, "attendance.manage")
    ? attendanceSchemaReady(pool).then((ok) => (ok ? dayFigures(pool, actor, almatyToday()) : null))
    : Promise.resolve(null);
  const [migrations, summary, outbox, counters, analytics, figures, workspace] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name DESC"),
    can(session.user.role, "catalog.view") ? catalogSummary(pool) : Promise.resolve(null),
    can(session.user.role, "contacts.view") ? outboxStats(pool) : Promise.resolve(null),
    dashboardCounters(pool, session.user.role),
    dashboardAnalytics(pool, session.user.role),
    attendance,
    managerWorkspace(pool, actor),
  ]);
  return { migrations: migrations.rows.map((r) => r.name), summary, outbox, counters, analytics, attendance: figures, workspace };
}

async function bookingCatalog(pool: Pool) {
  const summary = await catalogSummary(pool);
  const [packages, rooms] = [summary.packages, summary.rooms];
  const branch = { id: "almaty", slug: "almaty", name: "Boom Bala Алматы", city: "Алматы", workingHours: "10:00-22:00", bufferMinutes: 0 };
  return { branches: [branch], rooms: rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, branchId: "almaty", name: r.name, occupancyMode: r.occupancyMode ?? "exclusive" })), packages: packages.filter((p) => p.isActive).map((p) => ({ id: p.id, branchId: "almaty", name: p.name, priceFrom: p.basePrice ?? 0, priceLabel: p.basePrice == null ? "" : `${p.basePrice} ₸`, guestCapacityLabel: "" })) };
}

async function bookingTimeline(pool: Pool, session: ValidSession, date: string) {
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const rooms = await pool.query<{ id: string; name: string; occupancy_mode: string }>("SELECT id, name, occupancy_mode FROM bb.rooms WHERE is_active ORDER BY sort_order, id");
  const rows = await pool.query<{ id: string; kind: "booking" | "block"; room_id: string; starts_at: string; ends_at: string; slot_id: number | null; package_name: string | null; price_kzt: number | null; price_source: string | null; note: string | null; lead_request_id: string | null; customer_name: string | null; customer_phone: string | null; created_by: string | null; created_by_name: string | null; released_at: string | null; paid_kzt: number | null; sync_key: string | null; sync_state: "active" | "manual_review" | "source_missing" | "crm_managed" | null; sync_client: string | null; sync_phone: string | null; sync_package: string | null; sync_details: Record<string, string> | null; card_id: string | null; card_created_by: string | null; card_created_name: string | null; program_status: string | null; props_status: string | null; invitation_status: string | null; card_total: number | null; pricing_status: string | null; child_name: string | null; children_total: number | null; adults_total: number | null; headcount_mode: string | null; responsible_name: string | null }>(
    `SELECT r.id, r.kind, r.room_id, r.starts_at, r.ends_at, r.slot_id, p.name package_name, r.price_kzt, r.price_source, r.note,
            r.lead_request_id, c.name customer_name, c.phone_e164 customer_phone, r.created_by, u.name created_by_name, r.released_at,
            ss.source_key sync_key, ss.state sync_state, ss.source_payload->>'client' sync_client, ss.source_payload->>'phone' sync_phone,
            ss.source_payload->>'package' sync_package, CASE WHEN ss.source_key IS NULL THEN NULL ELSE jsonb_build_object(
              'childName',ss.source_payload->>'child','childAge',ss.source_payload->>'age','animator',ss.source_payload->>'animator',
              'children',ss.source_payload->>'children','adults',ss.source_payload->>'adults','prepaymentRaw',ss.source_payload->>'prepayment','comment',ss.source_payload->>'comment') END sync_details,
            (SELECT amount_kzt FROM bb.manual_payment_facts f WHERE f.lead_request_id=r.lead_request_id) paid_kzt,
            bc.id card_id, bc.created_by card_created_by, cu.name card_created_name, bc.program_status, bc.props_status, bc.invitation_status, bc.total_kzt card_total,
            bc.pricing_status, bc.child_name, bc.children_total, bc.adults_total, bc.headcount_mode, ru.name responsible_name
       FROM bb.slot_reservations r LEFT JOIN bb.packages p ON p.id=r.package_id LEFT JOIN bb.contacts c ON c.id=r.contact_id
       LEFT JOIN bb.users u ON u.id=r.created_by LEFT JOIN bb.sheet_sync_records ss ON ss.reservation_id=r.id
       LEFT JOIN bb.booking_cards bc ON bc.reservation_id=r.id LEFT JOIN bb.users cu ON cu.id=bc.created_by LEFT JOIN bb.users ru ON ru.id=bc.responsible_user_id
      WHERE r.slot_date=$1 ORDER BY r.starts_at`, [date]);
  return { branchId: "almaty", date, timezone: "Asia/Almaty", bufferMinutes: 0, rooms: rooms.rows.map((r) => ({ id: r.id, name: r.name, occupancyMode: r.occupancy_mode === "shared" ? "shared" : "exclusive" })), reservations: rows.rows.map((r) => ({ id: r.id, kind: r.kind, status: r.released_at ? "released" : r.kind === "block" ? "blocked" : "confirmed", roomId: r.room_id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), occupiedEndsAt: new Date(r.ends_at).toISOString(), slotId: r.slot_id == null ? null : String(r.slot_id), packageName: r.sync_package ?? r.package_name, priceKzt: r.price_kzt, priceSource: r.price_source, paidKzt: r.paid_kzt ?? 0, paymentStatus: r.paid_kzt ? "prepaid" : "unpaid", note: r.sync_key && r.sync_state !== "crm_managed" ? "Импортировано из Google Sheets" : r.note, requestId: r.lead_request_id, customerName: r.sync_client ?? r.customer_name, customerPhone: r.sync_phone ?? r.customer_phone, createdByAdminId: r.card_created_by ?? r.created_by, createdByName: r.card_created_name ?? r.created_by_name, releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null, sourceManaged: !!r.sync_key && r.sync_state !== "crm_managed", sourceHandedOver: r.sync_state === "crm_managed", sourceState: r.sync_state, sourceDetails: r.sync_details, card: r.card_id ? { programStatus: r.program_status, propsStatus: r.props_status, invitationStatus: r.invitation_status, totalKzt: r.card_total, pricingStatus: r.pricing_status, childName: r.child_name, childrenTotal: r.children_total, adultsTotal: r.adults_total, headcountMode: r.headcount_mode, responsibleName: r.responsible_name } : null })) };
}

/** Minimal, allowlisted read model for the upcoming operations page. Never select customer, child, comment, or raw sync payload fields. */
async function operationsOverview(pool: Pool, session: ValidSession, rawDates: unknown) {
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  if (!Array.isArray(rawDates) || rawDates.length !== 7) throw new ValidationError({ dates: "invalid_range" });
  const dates = [...new Set(rawDates.map((value) => parseDate(value)))];
  if (dates.length !== 7) throw new ValidationError({ dates: "invalid_range" });
  const rows = await pool.query<{
    id: string; date: string; kind: "booking" | "block"; status: "confirmed" | "blocked"; starts_at: Date;
    room_name: string; package_name: string | null; paid_kzt: string | null; source_state: "active" | "manual_review" | "source_missing" | "crm_managed" | null;
    payment_status: "prepaid" | "unpaid"; program_status: string | null; props_status: string | null; invitation_status: string | null; responsible_name: string | null;
  }>(
    `SELECT r.id, to_char(r.slot_date, 'YYYY-MM-DD') AS date, r.kind,
            CASE WHEN r.kind='booking' THEN 'confirmed' ELSE 'blocked' END AS status,
            r.starts_at, rm.name AS room_name,
            COALESCE(p.name, CASE WHEN r.kind='block' AND ss.source_key IS NOT NULL
              AND NULLIF(btrim(ss.source_payload->>'package'), '') IS NOT NULL THEN 'Пакет из таблицы — не проверен' END) AS package_name,
            CASE WHEN r.kind='booking' THEN f.amount_kzt::text END AS paid_kzt,
            CASE WHEN r.kind='block' THEN ss.state END AS source_state,
            CASE WHEN f.amount_kzt IS NOT NULL THEN 'prepaid' ELSE 'unpaid' END AS payment_status,
            CASE WHEN r.kind='booking' THEN bc.program_status END AS program_status,
            CASE WHEN r.kind='booking' THEN bc.props_status END AS props_status,
            CASE WHEN r.kind='booking' THEN bc.invitation_status END AS invitation_status,
            CASE WHEN r.kind='booking' THEN ru.name END AS responsible_name
       FROM bb.slot_reservations r
       JOIN bb.rooms rm ON rm.id=r.room_id
       LEFT JOIN bb.packages p ON p.id=r.package_id
       LEFT JOIN bb.sheet_sync_records ss ON ss.reservation_id=r.id
       LEFT JOIN bb.manual_payment_facts f ON f.lead_request_id=r.lead_request_id
       LEFT JOIN bb.booking_cards bc ON bc.reservation_id=r.id
       LEFT JOIN bb.users ru ON ru.id=bc.responsible_user_id
      WHERE r.slot_date=ANY($1::date[]) AND r.released_at IS NULL
        AND (r.kind='booking' OR (r.kind='block' AND ss.source_key IS NOT NULL))
      ORDER BY r.starts_at, r.id`,
    [dates],
  );
  return {
    timezone: "Asia/Almaty" as const,
    reservations: rows.rows.map((row) => {
      const paidKzt = row.paid_kzt === null ? 0 : Number(row.paid_kzt);
      if (!Number.isSafeInteger(paidKzt) || paidKzt < 0) throw new Error("operations_amount_invalid");
      return {
        id: row.id,
        date: row.date,
        kind: row.kind,
        status: row.status,
        startsAt: new Date(row.starts_at).toISOString(),
        room: row.room_name,
        packageName: row.package_name,
        paymentStatus: row.payment_status,
        paidKzt,
        sourceState: row.source_state,
        card: row.kind === "booking" && (row.program_status !== null || row.props_status !== null || row.invitation_status !== null || row.responsible_name !== null)
          ? { programStatus: row.program_status, propsStatus: row.props_status, invitationStatus: row.invitation_status, responsibleName: row.responsible_name }
          : null,
      };
    }),
  };
}

type CalendarLeadState = { id: string; status: string; bookedAt: string | null; manualPaymentFactStatus: "prepaid" | "unpaid"; manualPaymentFactAmountKzt: number; customerName: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The state of one request for the calendar (payment fact and whether a reservation exists). Null for an unknown or malformed id. */
async function calendarLeadState(pool: Pool, id: string): Promise<CalendarLeadState | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await pool.query<{ id: string; status: string; booked_at: string | null; name: string; payment_amount: number | null }>(
    "SELECT l.id,l.status,r.created_at booked_at,c.name,(SELECT amount_kzt FROM bb.manual_payment_facts p WHERE p.lead_request_id=l.id) payment_amount FROM bb.lead_requests l JOIN bb.contacts c ON c.id=l.contact_id LEFT JOIN bb.slot_reservations r ON r.lead_request_id=l.id AND r.released_at IS NULL WHERE l.id=$1",
    [id],
  );
  const x = row.rows[0];
  if (!x) return null;
  return { id: x.id, status: x.status, bookedAt: x.booked_at, manualPaymentFactStatus: x.payment_amount ? "prepaid" : "unpaid", manualPaymentFactAmountKzt: x.payment_amount ?? 0, customerName: x.name };
}

/** Requests of one day that still wait for a decision. Filtered in SQL: the calendar never needs the whole request list. */
const CALENDAR_OPEN_REQUESTS_LIMIT = 200;
async function calendarOpenRequests(pool: Pool, date: string) {
  const rows = await pool.query<{ id: string; status: string; phone_e164: string; name: string; created_at: Date; requested_date: string }>(
    `SELECT l.id, l.status, c.phone_e164, c.name, l.created_at, to_char(l.requested_date,'YYYY-MM-DD') requested_date
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id=l.contact_id
      WHERE l.requested_date=$1 AND l.status IN ('new','in_progress')
      ORDER BY l.created_at DESC LIMIT ${CALENDAR_OPEN_REQUESTS_LIMIT + 1}`,
    [date],
  );
  const items = rows.rows.slice(0, CALENDAR_OPEN_REQUESTS_LIMIT).map((l) => ({ id: l.id, type: "birthday_request", status: l.status, phone: l.phone_e164, customerName: l.name, createdAt: l.created_at.toISOString(), requestedDate: l.requested_date, branch: { id: "almaty" } }));
  // `total` larger than `items` is how the page learns that the list was cut.
  return { items, total: rows.rows.length > CALENDAR_OPEN_REQUESTS_LIMIT ? CALENDAR_OPEN_REQUESTS_LIMIT + 1 : items.length };
}

/**
 * Everything the calendar page needs in ONE round trip: catalog, the day's timeline, open requests of the day and the request
 * states it displays. The reads run in parallel on the VPS. Reservation availability is never cached: the timeline is read
 * fresh on every call. Requires the same permission as the calendar page.
 */
export async function calendarView(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const date = parseDate(input.date);
  const optionalId = (value: unknown) => (typeof value === "string" && UUID_RE.test(value) ? value : null);
  const requestId = optionalId(input.request);
  const reservationId = optionalId(input.reservation);
  const continueId = optionalId(input.continue);
  const timeline = bookingTimeline(pool, session, date);
  const [catalog, tl, leads, lead, bookingLead, continued] = await Promise.all([
    bookingCatalog(pool),
    timeline,
    calendarOpenRequests(pool, date),
    requestId ? calendarLeadState(pool, requestId) : Promise.resolve(null),
    // The request behind a selected reservation: resolved in SQL, so it does not wait for the timeline to travel anywhere.
    reservationId
      ? pool
          .query<{ lead_request_id: string | null }>("SELECT lead_request_id FROM bb.slot_reservations WHERE id=$1 AND slot_date=$2", [reservationId, date])
          .then((r) => (r.rows[0]?.lead_request_id ? calendarLeadState(pool, r.rows[0].lead_request_id) : null))
      : Promise.resolve(null),
    continueId ? getLead(pool, actorOf(session), continueId) : Promise.resolve(null),
  ]);
  return { catalog, timeline: tl, leads, lead, bookingLead, continued };
}

/** The request queue page in one round trip: the filtered page and the package names it shows. */
export async function requestsIndex(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  const [result, packages] = await Promise.all([searchLeads(pool, actor, leadFilter(input)), listPackages(pool)]);
  return { result, packages };
}

/** One request card with the catalog it needs, in one round trip. Not found is a 404 like `requests.get`. */
export async function requestCard(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  const id = text(input.id, 80);
  const [lead, packages, rooms, slots, workflowContext] = await Promise.all([
    getLead(pool, actor, id), listPackages(pool), listRooms(pool), listSlots(pool), getLeadWorkflowContext(pool, actor, id),
  ]);
  if (!lead) throw new NotFoundError();
  return { lead, catalog: { packages, rooms, slots }, workflowContext };
}

/** Typed lead-workflow writers; identity and role come only from the validated CRM session. */
export async function bridgeUpdateLeadWorkflow(pool: Pool, session: ValidSession, input: Record<string, unknown>, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  return updateLeadWorkflow(pool, actorOf(session), input, meta);
}

export async function bridgeClaimLead(pool: Pool, session: ValidSession, input: Record<string, unknown>, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  return claimLead(pool, actorOf(session), input, meta);
}

async function ensureIdempotent<T>(pool: Pool, actor: Actor, key: string, operation: string, input: unknown, run: (tx: import("../core/db.ts").Client) => Promise<T>): Promise<T> {
  const requestHash = hashInput(input);
  return withTx(pool, async (tx) => {
    // The advisory transaction lock serialises every call with the same key; the primary key backs it up. No row lock is taken on
    // booking_operations: it is append-only and bb_admin has no UPDATE privilege on it (SELECT ... FOR UPDATE would need one).
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`bridge-idempotency:${key}`]);
    const found = await tx.query<{ request_hash: string; result: T }>("SELECT request_hash, result FROM bb.booking_operations WHERE idempotency_key=$1", [key]);
    if (found.rows[0]) {
      if (found.rows[0].request_hash !== requestHash) throw new ConflictError("idempotency_conflict");
      return found.rows[0].result;
    }
    const result = await run(tx);
    await tx.query("INSERT INTO bb.booking_operations (idempotency_key, operation_name, request_hash, result, created_by) VALUES ($1,$2,$3,$4,$5)", [key, operation, requestHash, JSON.stringify(result), actor.id]);
    return result;
  });
}

export async function bridgeCreateRequest(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
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

export async function bridgePayment(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const requestId = text(input.requestId, 80);
  const key = text(input.idempotencyKey, 200);
  const amount = Number(input.amountKzt);
  if (!Number.isInteger(amount) || amount !== 10000) throw new ValidationError({ amountKzt: "Предоплата должна быть 10 000 ₸" });
  const method = text(input.method, 30);
  if (!["cash", "card_terminal", "bank_transfer", "other_manual"].includes(method)) throw new ValidationError({ method: "invalid" });
  return ensureIdempotent(pool, actor, key, "payment", input, async (tx) => {
    // The parent request row lock serialises payments for one request (also under different keys). manual_payment_facts is
    // append-only (no UPDATE privilege), so it is read without a row lock; UNIQUE (lead_request_id) and UNIQUE (idempotency_key) back it up.
    const lead = await tx.query("SELECT id,status FROM bb.lead_requests WHERE id=$1 FOR UPDATE", [requestId]);
    if (!lead.rows[0]) throw new NotFoundError();
    const existing = await tx.query<{ id: string; amount_kzt: number; payment_method: string }>("SELECT id,amount_kzt,payment_method FROM bb.manual_payment_facts WHERE lead_request_id=$1", [requestId]);
    if (existing.rows[0]) {
      if (existing.rows[0].amount_kzt !== amount || existing.rows[0].payment_method !== method) throw new ConflictError("idempotency_conflict");
      return { id: existing.rows[0].id, amountKzt: existing.rows[0].amount_kzt, method: existing.rows[0].payment_method, status: "prepaid" };
    }
    const saved = await tx.query<{ id: string; amount_kzt: number; payment_method: string }>("INSERT INTO bb.manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,note,recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,amount_kzt,payment_method", [requestId, amount, method, key, optionalText(input.note), actor.id]);
    await recordPrepayment(tx, actor.id, requestId, { amountKzt: amount, method });
    return { id: saved.rows[0].id, amountKzt: saved.rows[0].amount_kzt, method: saved.rows[0].payment_method, status: "prepaid" };
  });
}

export async function bridgeReschedule(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  return bridgeRescheduleWithActor(pool, actor, input, false, await requestMeta());
}

/** Internal Sheets worker entry point. It shares the same transactional writer and is never routed from HTTP. */
export async function bridgeRescheduleFromSheetSync(pool: Pool, actor: Actor, input: Record<string, unknown>, record: SheetSyncRecordInput) {
  if (!can(actor.role, "bookings.manage")) throw new ForbiddenError();
  return bridgeRescheduleWithActor(pool, actor, input, true, { ip: null, userAgent: "google-sheets-sync" }, validateSheetSyncRecord(record));
}

async function bridgeRescheduleWithActor(pool: Pool, actor: Actor, input: Record<string, unknown>, sourceSync: boolean, meta: { ip?: string | null; userAgent?: string | null }, syncRecord?: SheetSyncRecordInput) {
  const key = text(input.idempotencyKey, 200); const id = text(input.reservationId, 80); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120);
  return ensureIdempotent(pool, actor, key, "reschedule", input, async (tx) => {
    if (!sourceSync && process.env.SHEETS_SYNC_ENABLED === "1") {
      const managed = await tx.query("SELECT 1 FROM bb.sheet_sync_records WHERE reservation_id=$1 AND state <> 'crm_managed'", [id]);
      if (managed.rows[0]) throw new ConflictError("source_managed_read_only");
    }
    const old = await tx.query<{ kind: "booking" | "block"; room_id: string; lead_request_id: string | null; contact_id: string | null; package_id: string | null; children: number | null; price_kzt: number | null; price_source: string | null; note: string | null; created_by: string; slot_date: string; start_time: string }>("SELECT kind,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,note,created_by,to_char(slot_date,'YYYY-MM-DD') slot_date,to_char(starts_at AT TIME ZONE 'Asia/Almaty','HH24:MI') start_time FROM bb.slot_reservations WHERE id=$1 AND released_at IS NULL FOR UPDATE", [id]);
    if (!old.rows[0]) throw new NotFoundError();
    if (sourceSync && old.rows[0].kind !== "block") throw new ConflictError("source_sync_only_manages_blocks");
    const { startSql, endSql } = almatyInterval(date, start);
    await tx.query("UPDATE bb.slot_reservations SET released_at=now(),released_by=$2,release_reason='rescheduled' WHERE id=$1", [id, actor.id]);
    const nextNote = sourceSync ? text(input.note, 300) : old.rows[0].note;
    const next = await tx.query<{ id: string }>("INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,note,created_by,starts_at,ends_at) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id", [old.rows[0].kind, date, roomId, old.rows[0].lead_request_id, old.rows[0].contact_id, old.rows[0].package_id, old.rows[0].children, old.rows[0].price_kzt, old.rows[0].price_source, nextNote, sourceSync ? actor.id : old.rows[0].created_by, startSql, endSql]);
    await followReschedule(tx, actor.id, id, next.rows[0].id, { from: { date: old.rows[0].slot_date, roomId: old.rows[0].room_id, start: old.rows[0].start_time }, to: { date, roomId, start } });
    if (sourceSync && syncRecord) await persistSheetSyncRecord(tx, syncRecord, next.rows[0].id);
    if (old.rows[0].lead_request_id) await tx.query("UPDATE bb.lead_requests SET requested_date=$2,room_id=$3 WHERE id=$1", [old.rows[0].lead_request_id, date, roomId]);
    await writeAudit(tx, { actorUserId: actor.id, action: sourceSync ? "sheet_sync.rescheduled" : "booking.rescheduled", entityType: "slot_reservation", entityId: next.rows[0].id, after: { previousReservationId: id, date, roomId, start }, ...meta });
    return { id: next.rows[0].id, status: "confirmed" };
  });
}

export async function bridgeConfirm(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const leadId = text(input.requestId, 80); const key = text(input.idempotencyKey, 200); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120); const packageId = text(input.packageId, 120);
  const cardPatch = input.card === undefined ? {} : parseCardPatch(input.card);
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
    await ensureCard(tx, actor.id, reservation.rows[0].id, cardPatch);
    await writeAudit(tx, { actorUserId: actor.id, action: "booking.confirmed", entityType: "slot_reservation", entityId: reservation.rows[0].id, after: { leadId, date, roomId, start, packageId }, ...(await requestMeta()) });
    return { id: reservation.rows[0].id, status: "confirmed" };
  });
}

/** The booking card of one event: fields, the package program rules, the calculated amount and the change history. */
export async function bridgeCardGet(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const id = text(input.reservationId, 80);
  if (!UUID_RE.test(id)) throw new NotFoundError();
  return getCardView(pool, id);
}

/** Saves card fields. Idempotent per key; a stale `expectedVersion` is refused (another manager saved first). */
export async function bridgeCardSave(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const key = text(input.idempotencyKey, 200);
  const id = text(input.reservationId, 80);
  if (!UUID_RE.test(id)) throw new NotFoundError();
  const expected = input.expectedVersion === null || input.expectedVersion === undefined ? null : Number(input.expectedVersion);
  if (expected !== null && !Number.isInteger(expected)) throw new ValidationError({ expectedVersion: "invalid" });
  const patch = parseCardPatch(input.fields ?? {});
  const meta = await requestMeta();
  return ensureIdempotent(pool, actor, key, "card", input, (tx) => saveCard(tx, actor.id, id, expected, patch, meta));
}

/** Hands a Google Sheets record over to the CRM (sync stops managing it). Owner-visible, idempotent. */
export async function bridgeHandover(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session);
  if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  const key = text(input.idempotencyKey, 200);
  const id = text(input.reservationId, 80);
  if (!UUID_RE.test(id)) throw new NotFoundError();
  const meta = await requestMeta();
  return ensureIdempotent(pool, actor, key, "handover", input, (tx) => handoverSheetRecord(tx, actor.id, id, meta));
}

export async function bridgeBlock(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError();
  return bridgeBlockWithActor(pool, actor, input, false, await requestMeta());
}

/** Internal Sheets worker entry point. It shares the typed block writer; it cannot create bookings or payment facts. */
export async function bridgeBlockFromSheetSync(pool: Pool, actor: Actor, input: Record<string, unknown>, record: SheetSyncRecordInput) {
  if (!can(actor.role, "bookings.manage")) throw new ForbiddenError();
  return bridgeBlockWithActor(pool, actor, input, true, { ip: null, userAgent: "google-sheets-sync" }, validateSheetSyncRecord(record));
}

async function bridgeBlockWithActor(pool: Pool, actor: Actor, input: Record<string, unknown>, sourceSync: boolean, meta: { ip?: string | null; userAgent?: string | null }, syncRecord?: SheetSyncRecordInput) {
  const key = text(input.idempotencyKey, 200); const date = parseDate(input.bookingDate); const start = parseTime(input.startTime); ensureWorkingHours(start); const roomId = text(input.roomId, 120); const { startSql, endSql } = almatyInterval(date, start);
  return ensureIdempotent(pool, actor, key, "block", input, async (tx) => {
    const row = await tx.query<{ id: string }>("INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block',$1,NULL,$2,$3,$4,$5,$6) RETURNING id", [date, roomId, text(input.reason, 300), actor.id, startSql, endSql]);
    if (sourceSync && syncRecord) await persistSheetSyncRecord(tx, syncRecord, row.rows[0].id);
    if (sourceSync) await writeAudit(tx, { actorUserId: actor.id, action: "sheet_sync.block_created", entityType: "slot_reservation", entityId: row.rows[0].id, after: { date, roomId, start }, ...meta });
    return { id: row.rows[0].id, status: "blocked" };
  });
}

export async function bridgeRelease(pool: Pool, session: ValidSession, input: Record<string, unknown>) {
  const actor = actorOf(session); if (!can(session.user.role, "bookings.manage")) throw new ForbiddenError(); const key = text(input.idempotencyKey, 200); const id = text(input.reservationId, 80);
  return ensureIdempotent(pool, actor, key, "release", input, async (tx) => {
    if (process.env.SHEETS_SYNC_ENABLED === "1") {
      const managed = await tx.query("SELECT 1 FROM bb.sheet_sync_records WHERE reservation_id=$1 AND state <> 'crm_managed'", [id]);
      if (managed.rows[0]) throw new ConflictError("source_managed_read_only");
    }
    const row = await tx.query<{ kind: string; lead_request_id: string | null }>("UPDATE bb.slot_reservations SET released_at=now(),released_by=$2,release_reason=$3 WHERE id=$1 AND released_at IS NULL RETURNING kind,lead_request_id", [id, actor.id, optionalText(input.reason)]);
    if (!row.rows[0]) throw new ConflictError("reservation_already_released");
    if (row.rows[0].lead_request_id) await tx.query("UPDATE bb.lead_requests SET status='cancelled' WHERE id=$1 AND status='confirmed'", [row.rows[0].lead_request_id]);
    await recordCancellation(tx, actor.id, id, optionalText(input.reason) ?? null);
    await writeAudit(tx, { actorUserId: actor.id, action: row.rows[0].kind === "block" ? "block.released" : "booking.cancelled", entityType: "slot_reservation", entityId: id, after: { reason: optionalText(input.reason) }, ...(await requestMeta()) });
    return { id, status: "released" };
  });
}

/**
 * Measured wrapper: the answer carries `Server-Timing` (session check, whole handler, SQL count and summed SQL time) and,
 * with CRM_PERF_LOG=1, the same numbers go to the log. Only the operation name and durations are recorded, never input or rows.
 */
export async function bridgeRpc(request: NextRequest): Promise<Response> {
  const started = performance.now();
  const marks = { op: "?", sessionMs: 0 };
  const { result: response, perf } = await runWithPerf(() => rpcCore(request, marks));
  const total = performance.now() - started;
  const timing = `session;dur=${marks.sessionMs.toFixed(1)}, handler;dur=${total.toFixed(1)}, db;dur=${perf.dbMs.toFixed(1)};desc="${perf.queries} queries"`;
  const out = new Response(response.body, response);
  out.headers.set("Server-Timing", timing);
  if (process.env.CRM_PERF_LOG === "1") console.info(`[bridge-perf] op=${marks.op} status=${response.status} ${timing}`);
  return out;
}

async function rpcCore(request: NextRequest, marks: { op: string; sessionMs: number }): Promise<Response> {
  try {
    assertBridgeService(request);
    const sessionStarted = performance.now();
    const { session } = await bridgeSession(request);
    marks.sessionMs = performance.now() - sessionStarted;
    const body = await readJson(request);
    const op = text(body.op, 80);
    marks.op = op;
    const input = record(body.input ?? {});
    const pool = getPool(); const actor = actorOf(session);
    switch (op) {
      case "dashboard": return Response.json(await dashboard(pool, session), { headers: { "Cache-Control": "no-store" } });
      case "requests.list": return Response.json(await listLeads(pool, actor, typeof input.status === "string" ? { status: input.status } : {}), { headers: { "Cache-Control": "no-store" } });
      case "requests.index": return Response.json(await requestsIndex(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "requests.card": return Response.json(await requestCard(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "calendar.view": return Response.json(await calendarView(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "requests.search": return Response.json(await searchLeads(pool, actor, leadFilter(input)), { headers: { "Cache-Control": "no-store" } });
      case "requests.get": { const lead = await getLead(pool, actor, text(input.id, 80)); if (!lead) throw new NotFoundError(); return Response.json(lead, { headers: { "Cache-Control": "no-store" } }); }
      case "requests.status": await setLeadStatus(pool, actor, text(input.id, 80), text(input.status, 30) as "new" | "in_progress" | "cancelled", await requestMeta()); return Response.json({ ok: true });
      case "requests.workflow.update": return Response.json(await bridgeUpdateLeadWorkflow(pool, session, input, await requestMeta()), { headers: { "Cache-Control": "no-store" } });
      case "requests.workflow.claim": return Response.json(await bridgeClaimLead(pool, session, input, await requestMeta()), { headers: { "Cache-Control": "no-store" } });
      // The legacy slot-confirmation writer is deliberately unavailable in bridge mode.
      // Booking confirmation must go through payment -> interval reservation -> read-after-write.
      case "requests.confirm": throw new ConflictError("use_calendar_flow");
      case "catalog": return Response.json({ packages: await listPackages(pool), rooms: await listRooms(pool), slots: await listSlots(pool) });
      case "calendar.catalog": return Response.json(await bookingCatalog(pool), { headers: { "Cache-Control": "no-store" } });
      case "calendar.timeline": return Response.json(await bookingTimeline(pool, session, parseDate(input.date)), { headers: { "Cache-Control": "no-store" } });
      case "operations.overview": return Response.json(await operationsOverview(pool, session, input.dates), { headers: { "Cache-Control": "no-store" } });
      case "calendar.leads": { const leads = await listLeads(pool, actor, {}); return Response.json({ items: leads.map((l) => ({ id: l.id, type: "birthday_request", status: l.status, phone: l.phone, customerName: l.name, createdAt: l.createdAt.toISOString(), requestedDate: l.requestedDate, branch: { id: "almaty" } })), total: leads.length }); }
      case "calendar.lead": { const state = await calendarLeadState(pool, text(input.id, 80)); if (!state) throw new NotFoundError(); return Response.json(state); }
      case "booking.request": return Response.json(await bridgeCreateRequest(pool, session, input));
      case "booking.payment": return Response.json(await bridgePayment(pool, session, input));
      case "booking.confirm": return Response.json(await bridgeConfirm(pool, session, input));
      case "booking.block": return Response.json(await bridgeBlock(pool, session, input));
      case "booking.reschedule": return Response.json(await bridgeReschedule(pool, session, input));
      case "booking.release": return Response.json(await bridgeRelease(pool, session, input));
      case "booking.card": return Response.json(await bridgeCardGet(pool, session, input), { headers: { "Cache-Control": "no-store" } });
      case "booking.card.save": return Response.json(await bridgeCardSave(pool, session, input));
      case "booking.handover": return Response.json(await bridgeHandover(pool, session, input));
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
      case "users.passwordSelf": await changeOwnPassword(pool, actor, text(input.currentPassword, 128), text(input.newPassword, 128), await requestMeta()); return Response.json({ ok: true });
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
