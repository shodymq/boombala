import { randomUUID } from "node:crypto";
import { z } from "zod";

const leadStatus = z.enum(["new", "contacted", "qualified", "booked", "paid", "completed", "lost", "in_progress", "confirmed", "cancelled", "closed"]);
const branchSummary = z.object({ id: z.string(), name: z.string(), shortLabel: z.string() });
const packageSummary = z.object({ id: z.string(), name: z.string() });
const leadListItem = z.object({
  id: z.string(),
  type: z.enum(["birthday_request", "contact"]),
  summary: z.string(),
  status: leadStatus,
  source: z.string(),
  customerName: z.string(),
  phone: z.string(),
  guestCount: z.number().nullable(),
  requestedDate: z.string().nullable(),
  createdAt: z.string(),
  branch: branchSummary.nullable(),
  package: packageSummary.nullable(),
});
const leadList = z.object({ items: z.array(leadListItem), total: z.number().int().nonnegative() });
const leadDetail = z.object({
  id: z.string(),
  type: z.enum(["birthday_request", "contact"]),
  summary: z.string(),
  status: leadStatus,
  source: z.string(),
  customerName: z.string(),
  phone: z.string(),
  guestCount: z.number().nullable(),
  requestedDate: z.string().nullable(),
  createdAt: z.string(),
  branch: branchSummary.nullable(),
  package: packageSummary.nullable(),
  email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  contactMethod: z.string(),
});
const refundFact = z.object({
  id: z.string(),
  requestId: z.string(),
  amountKzt: z.number().int().positive(),
  method: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  refundedAt: z.string(),
  recordedByAdminId: z.string(),
  reason: z.string(),
  source: z.literal("manager_manual"),
  idempotencyKey: z.string(),
  createdAt: z.string(),
});
const paymentFact = z.object({
  id: z.string(),
  amountKzt: z.number().int().positive(),
  method: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  receivedAt: z.string(),
  recordedByAdminId: z.string(),
  recordedByAdminName: z.string(),
  note: z.string().nullable(),
  source: z.literal("manager_manual"),
  createdAt: z.string(),
});
const bookingAuditEvent = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.enum(["booking", "payment", "refund", "lead"]),
  entityId: z.string(),
  requestId: z.string().nullable().optional(),
  reservationId: z.string().nullable().optional(),
  branchId: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  createdAt: z.string(),
  before: z.record(z.string(), z.unknown()).nullable().optional(),
  after: z.record(z.string(), z.unknown()).nullable().optional(),
});
const birthdayLead = z.object({
  id: z.string(),
  status: leadStatus,
  source: z.string(),
  customerName: z.string(),
  phone: z.string(),
  contactMethod: z.string(),
  childName: z.string().nullable().optional(),
  roomId: z.string().nullable().optional(),
  slotId: z.string().nullable().optional(),
  requestedDate: z.string().nullable().optional(),
  guestCount: z.number().nullable().optional(),
  branch: branchSummary.nullable().optional(),
  package: packageSummary.nullable().optional(),
  packageNameSnapshot: z.string().nullable().optional(),
  packagePriceSnapshot: z.number().nullable().optional(),
  manualPaymentFacts: z.array(paymentFact),
  agreedAmountTenge: z.number().nullable().optional(),
  expectedAmountTenge: z.number().nullable().optional(),
  manualRefundFacts: z.array(refundFact),
  manualRefundFactAmountKzt: z.number().int().nonnegative(),
  netManualPaymentAmountKzt: z.number().int().nonnegative(),
  manualPaymentFactAmountKzt: z.number().int().nonnegative(),
  manualPaymentFactStatus: z.enum(["unpaid", "prepaid"]),
  lostReason: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  adminNote: z.string().nullable().optional(),
  createdAt: z.string(),
});
const bookingTimeline = z.object({
  branchId: z.string(),
  date: z.string(),
  timezone: z.literal("Asia/Almaty"),
  bufferMinutes: z.number().int().nonnegative(),
  rooms: z.array(z.object({ id: z.string(), name: z.string() })),
  reservations: z.array(z.object({
    id: z.string(),
    kind: z.enum(["booking", "block"]),
    status: z.enum(["confirmed", "blocked", "released"]),
    roomId: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    occupiedEndsAt: z.string(),
    slotId: z.string().nullable(),
    packageName: z.string().nullable(),
    priceKzt: z.number().nullable(),
    priceSource: z.string().nullable(),
    paidKzt: z.number().int().nonnegative(),
    paymentStatus: z.enum(["unpaid", "prepaid"]),
    note: z.string().nullable(),
    requestId: z.string().nullable(),
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    createdByAdminId: z.string().nullable(),
    createdByName: z.string().nullable(),
  })),
});
const bookingCatalog = z.object({
  branches: z.array(z.object({ id: z.string(), name: z.string(), city: z.string(), workingHours: z.string(), bufferMinutes: z.number().int().nonnegative() })),
  rooms: z.array(z.object({ id: z.string(), branchId: z.string(), name: z.string() })),
  packages: z.array(z.object({ id: z.string(), branchId: z.string(), name: z.string(), priceFrom: z.number().int().nonnegative(), priceLabel: z.string(), guestCapacityLabel: z.string() })),
});
const adminBirthdayPackageFields = {
  id: z.string(),
  branch_id: z.string(),
  slug: z.string(),
  name: z.string(),
  price_from: z.number().int().nonnegative(),
  price_label: z.string(),
  guest_capacity_label: z.string(),
  image_url: z.string().nullable(),
  is_featured: z.boolean(),
  is_active: z.boolean(),
  display_order: z.number().int().nonnegative(),
};
const adminBirthdayPackageSummary = z.object(adminBirthdayPackageFields).transform((item) => ({
  id: item.id,
  branchId: item.branch_id,
  slug: item.slug,
  name: item.name,
  priceFrom: item.price_from,
  priceLabel: item.price_label,
  guestCapacityLabel: item.guest_capacity_label,
  imageUrl: item.image_url,
  isFeatured: item.is_featured,
  isActive: item.is_active,
  displayOrder: item.display_order,
}));
const adminBirthdayPackage = z.object({ ...adminBirthdayPackageFields, description: z.string(), highlights: z.array(z.string()) }).transform((item) => ({
  ...adminBirthdayPackageSummary.parse(item),
  description: item.description,
  highlights: item.highlights,
}));
const reservationResult = z.object({ id: z.string(), kind: z.enum(["booking", "block"]), status: z.enum(["confirmed", "blocked", "released"]) });
const staffRequestResult = z.object({ id: z.string(), status: z.string(), branchId: z.string(), packageId: z.string().nullable(), requestedDate: z.string().nullable(), guestCount: z.number().nullable(), source: z.string() });
const paymentResult = z.object({
  id: z.string(),
  requestId: z.string(),
  amountKzt: z.number().int().positive(),
  method: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  receivedAt: z.string(),
  source: z.literal("manager_manual"),
  idempotencyKey: z.string(),
});
const refundResult = refundFact;

export type FastApiLeadStatus = z.infer<typeof leadStatus>;
export type FastApiBirthdayLead = z.infer<typeof birthdayLead>;
export type FastApiLeadDetail = z.infer<typeof leadDetail>;
export type BirthdayBookingCatalog = z.infer<typeof bookingCatalog>;
export type FastApiAdminBirthdayPackage = z.infer<typeof adminBirthdayPackage>;
export type FastApiAdminBirthdayPackageSummary = z.infer<typeof adminBirthdayPackageSummary>;
export type FastApiBirthdayBookingAuditEvent = z.infer<typeof bookingAuditEvent>;

export type FastApiCrmActor = {
  /** A short-lived FastAPI admin access token for the same staff actor. */
  accessToken: string;
  /** Correlation id shared by the CRM action and every FastAPI request. */
  requestId?: string;
};

export type BookingTimelineRoom = { id: string; name: string };

export type BookingTimelineReservation = {
  id: string;
  kind: "booking" | "block";
  status: "confirmed" | "blocked" | "released";
  roomId: string;
  startsAt: string;
  endsAt: string;
  occupiedEndsAt: string;
  slotId: string | null;
  packageName: string | null;
  priceKzt: number | null;
  priceSource: string | null;
  paidKzt: number;
  paymentStatus: "unpaid" | "prepaid";
  note: string | null;
  requestId: string | null;
  /** Null unless the staff role may see client data (super_admin, sales_manager). */
  customerName: string | null;
  customerPhone: string | null;
  createdByAdminId: string | null;
  createdByName: string | null;
};

export type BookingTimeline = {
  branchId: string;
  date: string;
  timezone: "Asia/Almaty";
  bufferMinutes: number;
  rooms: BookingTimelineRoom[];
  reservations: BookingTimelineReservation[];
};

export type FastApiLeadListItem = z.infer<typeof leadListItem>;

export type FastApiLeadList = {
  items: FastApiLeadListItem[];
  total: number;
};

export type FastApiCrmClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class FastApiCrmError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, code: string, requestId: string) {
    super(`FastAPI CRM request failed: ${code}`);
    this.name = "FastApiCrmError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function canRetryWithSameIdempotencyKey(error: unknown): boolean {
  return !(error instanceof FastApiCrmError) || error.status >= 500;
}

export class FastApiCrmConfigurationError extends Error {
  constructor(code: "crm_flag_disabled" | "crm_base_url_missing" | "crm_base_url_invalid" | "crm_actor_missing") {
    super(code);
    this.name = "FastApiCrmConfigurationError";
  }
}

/** The only approved enable value. Missing or any other value is disabled. */
export function unifiedFastapiCrmEnabled(): boolean {
  return process.env.UNIFIED_FASTAPI_CRM_ENABLED === "1";
}

function baseUrl(): string {
  const raw = (process.env.FASTAPI_ADMIN_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new FastApiCrmConfigurationError("crm_base_url_missing");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FastApiCrmConfigurationError("crm_base_url_invalid");
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new FastApiCrmConfigurationError("crm_base_url_invalid");
  return parsed.toString().replace(/\/+$/, "");
}

function readErrorCode(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
      return (error as { code: string }).code;
    }
  }
  return "fastapi_error";
}

export class FastApiCrmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestId: string;
  private readonly url: string;
  private readonly actor: FastApiCrmActor;

  constructor(actor: FastApiCrmActor, options: FastApiCrmClientOptions = {}) {
    if (!unifiedFastapiCrmEnabled()) throw new FastApiCrmConfigurationError("crm_flag_disabled");
    if (!actor.accessToken.trim()) throw new FastApiCrmConfigurationError("crm_actor_missing");
    this.url = baseUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5000, 1000), 10000);
    this.requestId = actor.requestId?.trim() || randomUUID();
    this.actor = actor;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.actor.accessToken}`);
    headers.set("Accept", "application/json");
    headers.set("X-Request-ID", this.requestId);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(`${this.url}/api/v1${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new FastApiCrmError(response.status, readErrorCode(body), this.requestId);
    return schema.parse(body);
  }

  listLeads(query: { branchId?: string; status?: string; q?: string; createdFrom?: string; createdTo?: string; awaitingContact?: boolean; sort?: "newest" | "oldest_uncontacted" } = {}): Promise<FastApiLeadList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request(`/admin/leads${suffix}`, leadList);
  }

  getBirthdayLead(leadId: string): Promise<FastApiBirthdayLead> {
    return this.request(`/admin/leads/${encodeURIComponent(leadId)}/birthday`, birthdayLead);
  }

  getLead(leadId: string): Promise<FastApiLeadDetail> {
    return this.request(`/admin/leads/${encodeURIComponent(leadId)}`, leadDetail);
  }

  updateLeadStatus(leadId: string, body: Record<string, unknown>): Promise<{ status: FastApiLeadStatus }> {
    return this.request(`/admin/leads/${encodeURIComponent(leadId)}/status`, z.object({ status: leadStatus }), { method: "PATCH", body: JSON.stringify(body) });
  }

  recordManualPayment(requestId: string, body: Record<string, unknown>): Promise<z.infer<typeof paymentResult>> {
    return this.request(`/admin/birthday-requests/${encodeURIComponent(requestId)}/manual-payments`, paymentResult, { method: "POST", body: JSON.stringify(body) });
  }

  recordManualRefund(requestId: string, body: Record<string, unknown>): Promise<z.infer<typeof refundResult>> {
    return this.request(`/admin/birthday-requests/${encodeURIComponent(requestId)}/manual-refunds`, refundResult, { method: "POST", body: JSON.stringify(body) });
  }

  confirmBooking(body: Record<string, unknown>): Promise<z.infer<typeof reservationResult>> {
    return this.request("/admin/birthday-bookings/confirm", reservationResult, { method: "POST", body: JSON.stringify(body) });
  }

  getBookingTimeline(branchId: string, date: string): Promise<BookingTimeline> {
    const params = new URLSearchParams({ branchId, date });
    return this.request(`/admin/birthday-bookings/timeline?${params.toString()}`, bookingTimeline);
  }

  listBirthdayBookingAudit(limit = 100): Promise<FastApiBirthdayBookingAuditEvent[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    return this.request(`/admin/birthday-bookings/audit?${params.toString()}`, z.array(bookingAuditEvent));
  }

  getBookingCatalog(branchId?: string): Promise<BirthdayBookingCatalog> {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request(`/admin/birthday-bookings/catalog${suffix}`, bookingCatalog);
  }

  listAdminBirthdayPackages(branchId: string): Promise<FastApiAdminBirthdayPackageSummary[]> {
    const params = new URLSearchParams({ branch_id: branchId, include_inactive: "true" });
    return this.request(`/admin/birthday-packages?${params.toString()}`, z.array(adminBirthdayPackageSummary));
  }

  getAdminBirthdayPackage(packageId: string): Promise<FastApiAdminBirthdayPackage> {
    return this.request(`/admin/birthday-packages/${encodeURIComponent(packageId)}`, adminBirthdayPackage);
  }

  updateAdminBirthdayPackage(packageId: string, body: Record<string, unknown>): Promise<FastApiAdminBirthdayPackage> {
    return this.request(`/admin/birthday-packages/${encodeURIComponent(packageId)}`, adminBirthdayPackage, { method: "PATCH", body: JSON.stringify(body) });
  }

  createAdminBirthdayPackage(body: Record<string, unknown>): Promise<FastApiAdminBirthdayPackage> {
    return this.request("/admin/birthday-packages", adminBirthdayPackage, { method: "POST", body: JSON.stringify(body) });
  }

  blockBookingSlot(body: Record<string, unknown>): Promise<z.infer<typeof reservationResult>> {
    return this.request("/admin/birthday-slots/block", reservationResult, { method: "POST", body: JSON.stringify(body) });
  }

  async blockBookingSlotAndRead(body: { branchId: string; bookingDate: string; roomId: string; startTime: string; reason: string; idempotencyKey: string }): Promise<z.infer<typeof reservationResult>> {
    const reservation = await this.blockBookingSlot(body);
    await this.assertReservationReadback(reservation, body.branchId, body.bookingDate, { roomId: body.roomId, startTime: body.startTime });
    return reservation;
  }

  createStaffBirthdayRequest(body: Record<string, unknown>): Promise<z.infer<typeof staffRequestResult>> {
    return this.request("/admin/birthday-requests", staffRequestResult, { method: "POST", body: JSON.stringify(body) });
  }

  rescheduleReservation(reservationId: string, body: Record<string, unknown>): Promise<z.infer<typeof reservationResult>> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/reschedule`, reservationResult, { method: "POST", body: JSON.stringify(body) });
  }

  releaseReservation(reservationId: string, body: Record<string, unknown>): Promise<z.infer<typeof reservationResult>> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/release`, reservationResult, { method: "POST", body: JSON.stringify(body) });
  }

  async releaseReservationAndRead(reservationId: string, branchId: string, date: string, body: { reason: string; idempotencyKey: string }): Promise<z.infer<typeof reservationResult>> {
    const reservation = await this.releaseReservation(reservationId, body);
    await this.assertReservationReadback(reservation, branchId, date);
    return reservation;
  }

  async rescheduleReservationAndRead(reservationId: string, branchId: string, body: { bookingDate: string; roomId: string; startTime: string; idempotencyKey: string }): Promise<z.infer<typeof reservationResult>> {
    const reservation = await this.rescheduleReservation(reservationId, body);
    await this.assertReservationReadback(reservation, branchId, body.bookingDate, { roomId: body.roomId, startTime: body.startTime });
    return reservation;
  }

  private async assertReservationReadback(
    result: z.infer<typeof reservationResult>,
    branchId: string,
    date: string,
    expected: { roomId?: string; startTime?: string } = {},
  ): Promise<void> {
    const timeline = await this.getBookingTimeline(branchId, date);
    const reservation = timeline.reservations.find((item) => item.id === result.id);
    if (
      !reservation ||
      reservation.kind !== result.kind ||
      reservation.status !== result.status ||
      (expected.roomId && reservation.roomId !== expected.roomId) ||
      (expected.startTime && reservation.startsAt.slice(0, 16) !== `${date}T${expected.startTime}`)
    ) {
      throw new FastApiCrmError(502, "reservation_readback_mismatch", this.requestId);
    }
  }

  async recordManualPaymentAndRead(requestId: string, body: Record<string, unknown>): Promise<{ payment: z.infer<typeof paymentResult>; lead: FastApiBirthdayLead }> {
    const payment = await this.recordManualPayment(requestId, body);
    const lead = await this.getBirthdayLead(requestId);
    const savedFact = lead.manualPaymentFacts.find((fact) => fact.id === payment.id);
    if (!savedFact || savedFact.amountKzt !== payment.amountKzt || savedFact.source !== payment.source) {
      throw new FastApiCrmError(502, "payment_readback_mismatch", this.requestId);
    }
    return { payment, lead };
  }

  async recordManualRefundAndRead(requestId: string, body: Record<string, unknown>): Promise<{ refund: z.infer<typeof refundResult>; lead: FastApiBirthdayLead }> {
    const refund = await this.recordManualRefund(requestId, body);
    const lead = await this.getBirthdayLead(requestId);
    const savedFact = lead.manualRefundFacts.find((fact) => fact.id === refund.id);
    if (!savedFact || savedFact.amountKzt !== refund.amountKzt || savedFact.source !== refund.source) {
      throw new FastApiCrmError(502, "refund_readback_mismatch", this.requestId);
    }
    return { refund, lead };
  }

  async confirmBookingAndRead(body: Record<string, unknown>): Promise<{ booking: z.infer<typeof reservationResult>; lead: FastApiBirthdayLead }> {
    const booking = await this.confirmBooking(body);
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const bookingDate = typeof body.bookingDate === "string" ? body.bookingDate : "";
    const roomId = typeof body.roomId === "string" ? body.roomId : "";
    const startTime = typeof body.startTime === "string" ? body.startTime : "";
    if (!requestId || !bookingDate || !roomId || !startTime) throw new FastApiCrmConfigurationError("crm_actor_missing");
    const lead = await this.getBirthdayLead(requestId);
    if (lead.status !== "booked" || lead.netManualPaymentAmountKzt < 10_000 || !lead.branch?.id) {
      throw new FastApiCrmError(502, "booking_readback_mismatch", this.requestId);
    }
    await this.assertReservationReadback(booking, lead.branch.id, bookingDate, { roomId, startTime });
    return { booking, lead };
  }

}

/**
 * Mutation callers must choose exactly one writer. When the flag is enabled,
 * callers must use this adapter and must not fall back to Platform SQL.
 */
export function assertUnifiedCrmMutationMode(): void {
  if (!unifiedFastapiCrmEnabled()) throw new FastApiCrmConfigurationError("crm_flag_disabled");
}
