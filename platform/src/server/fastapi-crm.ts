import { randomUUID } from "node:crypto";
import { birthdayStartTimes, hasBirthdayDuration, hasBirthdayStart } from "../core/birthday-booking-time.ts";

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
  paymentStatus: "unpaid" | "prepaid" | "unreconciled";
  note: string | null;
  requestId: string | null;
  /** Null unless the staff role may see client data (super_admin, sales_manager). */
  customerName: string | null;
  customerPhone: string | null;
  createdByAdminId: string | null;
};

export type BookingTimeline = {
  branchId: string;
  date: string;
  timezone: "Asia/Almaty";
  bufferMinutes: number;
  rooms: BookingTimelineRoom[];
  reservations: BookingTimelineReservation[];
};

export type FastApiManualPaymentMethod = "cash" | "card_terminal" | "bank_transfer" | "other_manual";
export type FastApiBirthdayPaymentKind = "initial_deposit" | "additional";

export type FastApiLeadListItem = {
  id: string;
  type: "birthday_request" | "contact";
  summary: string;
  status: string;
  source: string;
  customerName: string;
  phone: string;
  guestCount: number | null;
  requestedDate: string | null;
  createdAt: string;
  branch: { id: string; name: string; shortLabel: string } | null;
  package: { id: string; name: string } | null;
};

export type FastApiLeadStatus = "new" | "contacted" | "qualified" | "booked" | "paid" | "completed" | "lost" | "in_progress" | "confirmed" | "cancelled" | "closed";

export type FastApiLeadList = {
  items: FastApiLeadListItem[];
  total: number;
};

export type FastApiLeadDetail = FastApiLeadListItem & {
  email?: string | null;
  notes?: string | null;
  contactMethod: string;
};

export type FastApiBirthdayPayment = {
  id: string;
  amountKzt: number;
  paymentKind: FastApiBirthdayPaymentKind | null;
  method: FastApiManualPaymentMethod;
  receivedAt: string;
  recordedByAdminId: string;
  recordedByAdminName: string;
  note: string | null;
  source: "manager_manual";
  createdAt: string;
};

export type FastApiBirthdayManualPayment = Omit<FastApiBirthdayPayment, "recordedByAdminName" | "note"> & {
  requestId: string;
  idempotencyKey: string;
};

export type FastApiBirthdayManualRefund = {
  id: string;
  requestId: string;
  paymentFactId: string | null;
  amountKzt: number;
  method: FastApiManualPaymentMethod;
  refundedAt: string;
  recordedByAdminId: string;
  reason: string;
  source: "manager_manual";
  idempotencyKey: string;
  createdAt: string;
};

export type FastApiBirthdayLeadDetail = {
  id: string;
  status: string;
  source: string;
  customerName: string;
  phone: string;
  contactMethod: string;
  childName?: string | null;
  childBirthDate?: string | null;
  roomId?: string | null;
  slotId?: string | null;
  bookingReservationState: "none" | "active" | "released";
  requestedDate: string | null;
  guestCount: number | null;
  branch: FastApiLeadListItem["branch"];
  package: FastApiLeadListItem["package"];
  packageNameSnapshot?: string | null;
  packagePriceSnapshot?: number | null;
  agreedAmountTenge?: number | null;
  expectedAmountTenge?: number | null;
  depositAmountTenge?: number | null;
  paidAmountTenge?: number | null;
  manualPaymentFacts: FastApiBirthdayPayment[];
  manualRefundFacts: FastApiBirthdayManualRefund[];
  manualRefundFactAmountKzt: number;
  netManualPaymentAmountKzt: number;
  netInitialDepositKzt: number;
  manualPaymentFactAmountKzt: number;
  manualPaymentFactStatus: "unpaid" | "prepaid" | "unreconciled";
  lostReason?: string | null;
  comment?: string | null;
  adminNote?: string | null;
  createdAt: string;
};

export type FastApiBirthdayBookingCatalog = {
  branches: Array<{
    id: string;
    slug: string;
    name: string;
    city: string;
    workingHours: string;
    bufferMinutes: number;
  }>;
  rooms: Array<{ id: string; branchId: string; name: string }>;
  packages: Array<{
    id: string;
    branchId: string;
    name: string;
    priceFrom: number;
    priceLabel: string;
    guestCapacityLabel: string;
  }>;
};

export type FastApiBirthdayReservation = {
  id: string;
  kind: "booking" | "block";
  status: "confirmed" | "blocked" | "released";
  requestId: string | null;
  branchId: string;
  bookingDate: string;
  roomId: string;
  slotId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  packageId: string | null;
  priceKzt: number | null;
  priceSource: string | null;
  note: string | null;
  releasedAt: string | null;
};

export type FastApiBirthdayManualRefundInput = {
  amountKzt: number;
  paymentFactId: string;
  method: FastApiManualPaymentMethod;
  refundedAt: string;
  idempotencyKey: string;
  reason: string;
};

export type FastApiBirthdayManualPaymentInput = {
  amountKzt: number;
  paymentKind: FastApiBirthdayPaymentKind;
  method: FastApiManualPaymentMethod;
  idempotencyKey: string;
  note?: string;
  receivedAt?: string;
};

export type FastApiBirthdaySlotBlockInput = {
  branchId: string;
  bookingDate: string;
  roomId: string;
  startTime: string;
  reason: string;
  idempotencyKey: string;
};

export type FastApiBirthdayBookingConfirmInput = {
  requestId: string;
  bookingDate: string;
  roomId: string;
  startTime: string;
  packageId: string;
  agreedPriceKzt: number;
  idempotencyKey: string;
  note?: string;
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    return body as T;
  }

  listLeads(query: { branchId?: string; status?: string; q?: string; createdFrom?: string; createdTo?: string; awaitingContact?: boolean; sort?: "newest" | "oldest_uncontacted" } = {}): Promise<FastApiLeadList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<FastApiLeadList>(`/admin/leads${suffix}`);
  }

  async getBirthdayLead(leadId: string): Promise<FastApiBirthdayLeadDetail> {
    const birthday = await this.request<FastApiBirthdayLeadDetail>(`/admin/leads/${encodeURIComponent(leadId)}/birthday`);
    if (birthday.bookingReservationState !== "none" && birthday.bookingReservationState !== "active" && birthday.bookingReservationState !== "released") {
      throw new FastApiCrmError(502, "birthday_reservation_state_invalid", this.requestId);
    }
    return birthday;
  }

  getLead(leadId: string): Promise<FastApiLeadDetail> {
    return this.request<FastApiLeadDetail>(`/admin/leads/${encodeURIComponent(leadId)}`);
  }

  updateLeadStatus(leadId: string, body: { status: FastApiLeadStatus; lostReason?: string; adminNote?: string }): Promise<FastApiLeadDetail> {
    return this.request<FastApiLeadDetail>(`/admin/leads/${encodeURIComponent(leadId)}/status`, { method: "PATCH", body: JSON.stringify(body) });
  }

  recordManualPayment(requestId: string, body: FastApiBirthdayManualPaymentInput): Promise<FastApiBirthdayManualPayment> {
    return this.request<FastApiBirthdayManualPayment>(`/admin/birthday-requests/${encodeURIComponent(requestId)}/manual-payments`, { method: "POST", body: JSON.stringify(body) });
  }

  recordManualRefund(requestId: string, body: FastApiBirthdayManualRefundInput): Promise<FastApiBirthdayManualRefund> {
    return this.request<FastApiBirthdayManualRefund>(`/admin/birthday-requests/${encodeURIComponent(requestId)}/manual-refunds`, { method: "POST", body: JSON.stringify(body) });
  }

  getBookingCatalog(branchId?: string): Promise<FastApiBirthdayBookingCatalog> {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<FastApiBirthdayBookingCatalog>(`/admin/birthday-bookings/catalog${suffix}`);
  }

  blockBirthdaySlot(body: FastApiBirthdaySlotBlockInput): Promise<FastApiBirthdayReservation> {
    return this.request<FastApiBirthdayReservation>("/admin/birthday-slots/block", { method: "POST", body: JSON.stringify(body) });
  }

  confirmBooking(body: FastApiBirthdayBookingConfirmInput): Promise<FastApiBirthdayReservation> {
    return this.request<FastApiBirthdayReservation>("/admin/birthday-bookings/confirm", { method: "POST", body: JSON.stringify(body) });
  }

  getBookingTimeline(branchId: string, date: string): Promise<BookingTimeline> {
    const params = new URLSearchParams({ branchId, date });
    return this.request<BookingTimeline>(`/admin/birthday-bookings/timeline?${params.toString()}`);
  }

  rescheduleReservation(reservationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/reschedule`, { method: "POST", body: JSON.stringify(body) });
  }

  releaseReservation(reservationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/release`, { method: "POST", body: JSON.stringify(body) });
  }

  async recordManualPaymentAndRead(requestId: string, body: FastApiBirthdayManualPaymentInput): Promise<{ payment: FastApiBirthdayManualPayment; lead: FastApiBirthdayLeadDetail }> {
    const payment = await this.recordManualPayment(requestId, body);
    const lead = await this.getBirthdayLead(requestId);
    const savedFact = lead.manualPaymentFacts.find((fact) => fact.id === payment.id);
    if (
      payment.requestId !== requestId ||
      payment.amountKzt !== body.amountKzt ||
      payment.paymentKind !== body.paymentKind ||
      payment.method !== body.method ||
      payment.idempotencyKey !== body.idempotencyKey ||
      (body.receivedAt !== undefined && Date.parse(payment.receivedAt) !== Date.parse(body.receivedAt)) ||
      payment.source !== "manager_manual" ||
      !savedFact ||
      savedFact.amountKzt !== payment.amountKzt ||
      savedFact.paymentKind !== payment.paymentKind ||
      savedFact.method !== payment.method ||
      Date.parse(savedFact.receivedAt) !== Date.parse(payment.receivedAt) ||
      savedFact.source !== payment.source
    ) {
      throw new FastApiCrmError(502, "payment_readback_mismatch", this.requestId);
    }
    return { payment, lead };
  }

  async recordManualRefundAndRead(requestId: string, body: FastApiBirthdayManualRefundInput): Promise<{ refund: FastApiBirthdayManualRefund; lead: FastApiBirthdayLeadDetail }> {
    const refund = await this.recordManualRefund(requestId, body);
    const lead = await this.getBirthdayLead(requestId);
    const savedFact = lead.manualRefundFacts.find((fact) => fact.id === refund.id);
    if (
      refund.requestId !== requestId ||
      refund.paymentFactId !== body.paymentFactId ||
      refund.amountKzt !== body.amountKzt ||
      refund.method !== body.method ||
      Date.parse(refund.refundedAt) !== Date.parse(body.refundedAt) ||
      refund.reason !== body.reason ||
      refund.idempotencyKey !== body.idempotencyKey ||
      refund.source !== "manager_manual" ||
      !savedFact ||
      savedFact.paymentFactId !== refund.paymentFactId ||
      savedFact.amountKzt !== refund.amountKzt ||
      savedFact.method !== refund.method ||
      Date.parse(savedFact.refundedAt) !== Date.parse(refund.refundedAt) ||
      savedFact.reason !== refund.reason ||
      savedFact.idempotencyKey !== refund.idempotencyKey ||
      savedFact.source !== refund.source
    ) {
      throw new FastApiCrmError(502, "refund_readback_mismatch", this.requestId);
    }
    return { refund, lead };
  }

  async confirmBookingAndRead(
    body: FastApiBirthdayBookingConfirmInput,
    branch: Pick<FastApiBirthdayBookingCatalog["branches"][number], "workingHours" | "bufferMinutes">,
  ): Promise<{ booking: FastApiBirthdayReservation; lead: FastApiBirthdayLeadDetail }> {
    if (branch.bufferMinutes !== 0) {
      throw new FastApiCrmError(409, "booking_buffer_required", this.requestId);
    }
    if (!birthdayStartTimes(branch.workingHours).includes(body.startTime)) {
      throw new FastApiCrmError(409, "booking_time_outside_working_hours", this.requestId);
    }

    const booking = await this.confirmBooking(body);
    if (
      booking.kind !== "booking" ||
      booking.status !== "confirmed" ||
      booking.requestId !== body.requestId ||
      booking.bookingDate !== body.bookingDate ||
      booking.roomId !== body.roomId ||
      booking.packageId !== body.packageId ||
      booking.priceKzt !== body.agreedPriceKzt ||
      booking.priceSource !== "manager_agreed" ||
      !hasBirthdayStart(booking.startsAt, body.bookingDate, body.startTime) ||
      !hasBirthdayDuration(booking.startsAt, booking.endsAt)
    ) {
      throw new FastApiCrmError(502, "booking_response_mismatch", this.requestId);
    }
    const lead = await this.getBirthdayLead(body.requestId);
    if (lead.status !== "booked" || lead.netInitialDepositKzt !== 10000 || lead.manualPaymentFactStatus === "unreconciled" || !lead.branch?.id) {
      throw new FastApiCrmError(502, "booking_lead_readback_mismatch", this.requestId);
    }
    const timeline = await this.getBookingTimeline(lead.branch.id, body.bookingDate);
    const reservation = timeline.reservations.find((item) => item.id === booking.id);
    if (
      timeline.branchId !== lead.branch.id ||
      timeline.date !== body.bookingDate ||
      timeline.bufferMinutes !== 0 ||
      !reservation ||
      reservation.kind !== "booking" ||
      reservation.status !== "confirmed" ||
      reservation.requestId !== body.requestId ||
      reservation.roomId !== body.roomId ||
      !hasBirthdayStart(reservation.startsAt, body.bookingDate, body.startTime) ||
      Date.parse(reservation.endsAt) !== Date.parse(booking.endsAt ?? "") ||
      !hasBirthdayDuration(reservation.startsAt, reservation.endsAt) ||
      Date.parse(reservation.occupiedEndsAt) !== Date.parse(reservation.endsAt)
    ) {
      throw new FastApiCrmError(502, "booking_timeline_readback_mismatch", this.requestId);
    }
    return { booking, lead };
  }

  async releaseReservationAndRead(reservationId: string, body: Record<string, unknown>, requestId: string): Promise<{ reservation: unknown; lead: unknown }> {
    const reservation = await this.releaseReservation(reservationId, body);
    const lead = await this.getBirthdayLead(requestId);
    return { reservation, lead };
  }
}

/**
 * Mutation callers must choose exactly one writer. When the flag is enabled,
 * callers must use this adapter and must not fall back to Platform SQL.
 */
export function assertUnifiedCrmMutationMode(): void {
  if (!unifiedFastapiCrmEnabled()) throw new FastApiCrmConfigurationError("crm_flag_disabled");
}
