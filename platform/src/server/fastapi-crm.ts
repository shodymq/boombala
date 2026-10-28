import "server-only";
import { randomUUID } from "node:crypto";

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
  /** The four-hour party window. */
  startsAt: string;
  endsAt: string;
  /** End of the room occupancy, including the branch preparation buffer. The PostgreSQL overlap rule uses this value. */
  occupiedEndsAt: string;
  slotId: string | null;
  packageName: string | null;
  priceKzt: number | null;
  priceSource: string | null;
  /** Manager-recorded manual prepayment total. Never an online payment. */
  paidKzt: number;
  /** "prepaid" means a positive manual fact exists. It does not mean the booking is confirmed or paid online. */
  paymentStatus: "unpaid" | "prepaid";
  note: string | null;
  requestId: string | null;
  /** Null unless the staff role may see client data (super_admin, sales_manager). */
  customerName: string | null;
  customerPhone: string | null;
  createdByAdminId: string | null;
  /** The responsible staff member's name, when the server shares it. */
  createdByName: string | null;
  releasedAt?: string | null;
};

export type BookingTimeline = {
  branchId: string;
  date: string;
  timezone: "Asia/Almaty";
  bufferMinutes: number;
  rooms: BookingTimelineRoom[];
  reservations: BookingTimelineReservation[];
};

/** Booking-scoped catalog (camelCase). Only active rows; the server applies the caller's branch scope. */
export type BookingCatalogBranch = {
  id: string;
  slug: string;
  name: string;
  city: string;
  workingHours: string;
  bufferMinutes: number;
};
export type BookingCatalogRoom = { id: string; branchId: string; name: string };
export type BookingCatalogPackage = {
  id: string;
  branchId: string;
  name: string;
  /** Indicative "from" value. Never the agreed price. */
  priceFrom: number;
  priceLabel: string;
  guestCapacityLabel: string;
};
/** The FastAPI birthday lead read back after an action. Only these fields decide the calendar's money and booking text. */
export type BirthdayLeadState = {
  id: string;
  status: string;
  bookedAt: string | null;
  manualPaymentFactStatus: "unpaid" | "prepaid";
  manualPaymentFactAmountKzt: number;
  customerName: string;
};

export type BookingCatalog = { branches: BookingCatalogBranch[]; rooms: BookingCatalogRoom[]; packages: BookingCatalogPackage[] };

export type FastApiLeadListItem = { id: string; type: string; status: string; phone: string; customerName: string; createdAt: string };

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

  listLeads(query: { branchId?: string; status?: string; createdFrom?: string; createdTo?: string; awaitingContact?: boolean; sort?: "newest" | "oldest_uncontacted" } = {}): Promise<FastApiLeadList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<FastApiLeadList>(`/admin/leads${suffix}`);
  }

  getBirthdayLead(leadId: string): Promise<BirthdayLeadState> {
    return this.request<BirthdayLeadState>(`/admin/leads/${encodeURIComponent(leadId)}/birthday`);
  }

  updateLeadStatus(leadId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/leads/${encodeURIComponent(leadId)}/status`, { method: "PATCH", body: JSON.stringify(body) });
  }

  recordManualPayment(requestId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/birthday-requests/${encodeURIComponent(requestId)}/manual-payments`, { method: "POST", body: JSON.stringify(body) });
  }

  confirmBooking(body: Record<string, unknown>): Promise<unknown> {
    return this.request("/admin/birthday-bookings/confirm", { method: "POST", body: JSON.stringify(body) });
  }

  getBookingTimeline(branchId: string, date: string): Promise<BookingTimeline> {
    const params = new URLSearchParams({ branchId, date });
    return this.request<BookingTimeline>(`/admin/birthday-bookings/timeline?${params.toString()}`);
  }

  /** The only catalog the calendar reads. For an operator the server applies the assigned branch. */
  getBookingCatalog(branchId?: string): Promise<BookingCatalog> {
    const suffix = branchId ? `?${new URLSearchParams({ branchId }).toString()}` : "";
    return this.request<BookingCatalog>(`/admin/birthday-bookings/catalog${suffix}`);
  }

  createStaffRequest(body: Record<string, unknown>): Promise<{ id: string; status: string; branchId: string; packageId: string | null; requestedDate: string | null; guestCount: number | null; source: string }> {
    return this.request("/admin/birthday-requests", { method: "POST", body: JSON.stringify(body) });
  }

  blockSlot(body: Record<string, unknown>): Promise<unknown> {
    return this.request("/admin/birthday-slots/block", { method: "POST", body: JSON.stringify(body) });
  }

  rescheduleReservation(reservationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/reschedule`, { method: "POST", body: JSON.stringify(body) });
  }

  releaseReservation(reservationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/admin/birthday-reservations/${encodeURIComponent(reservationId)}/release`, { method: "POST", body: JSON.stringify(body) });
  }

  async recordManualPaymentAndRead(requestId: string, body: Record<string, unknown>): Promise<{ payment: unknown; lead: unknown }> {
    const payment = await this.recordManualPayment(requestId, body);
    const lead = await this.getBirthdayLead(requestId);
    return { payment, lead };
  }

  async confirmBookingAndRead(body: Record<string, unknown>): Promise<{ booking: unknown; lead: unknown }> {
    const booking = await this.confirmBooking(body);
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!requestId) throw new FastApiCrmConfigurationError("crm_actor_missing");
    const lead = await this.getBirthdayLead(requestId);
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
