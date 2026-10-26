/**
 * Pure part of the parent account on the site (phone login → personal cabinet). No "server-only" import, so
 * that scripts/parent-core.test.ts can run it under node. Cookies, the process-wide stores and the Next.js
 * pages live in ./server.ts and in the app routes.
 *
 * Identity: the SAME MobileUser as the Flutter app, via FastAPI. Nothing is created on the site side.
 */
import { enabledFeatures, FastapiError, parseFastapiConfig, type FastapiClient, type ParentChild, type ParentProfile, type ParentRequest } from "../fastapi/core.ts";

// ── Feature state ───────────────────────────────────────────────────────────────────────────────

export type ParentLoginOffReason =
  | "flag_off"
  | "rollback_profile"
  | "feature_off"
  | "fastapi_not_configured"
  | "production_not_approved"
  | "shared_session_store_not_implemented";

export type ParentLoginState = { enabled: true } | { enabled: false; reason: ParentLoginOffReason };

const off = (reason: ParentLoginOffReason): ParentLoginState => ({ enabled: false, reason });

/**
 * PARENT_LOGIN=on is required AND the FastAPI features `otp` and `account` must be on. Production is closed twice:
 * it needs PARENT_LOGIN_PRODUCTION_APPROVED=1 and a SHARED session store, which this PR does not implement. So the
 * code cannot enable parent login in production yet, whatever the env says.
 */
export function parentLoginState(env: Record<string, string | undefined>): ParentLoginState {
  if ((env.PARENT_LOGIN ?? "").trim() !== "on") return off("flag_off");
  if (env.SITE_PROFILE === "rollback-safe") return off("rollback_profile");
  const features = enabledFeatures(env.FASTAPI_FEATURES);
  if (!features.has("otp") || !features.has("account")) return off("feature_off");
  try {
    parseFastapiConfig(env);
  } catch {
    return off("fastapi_not_configured");
  }
  if (env.NODE_ENV === "production") {
    if (env.PARENT_LOGIN_PRODUCTION_APPROVED !== "1") return off("production_not_approved");
    return off("shared_session_store_not_implemented");
  }
  return { enabled: true };
}

// ── Phone, origin, CSRF ─────────────────────────────────────────────────────────────────────────

/**
 * Kazakhstan mobile prefixes (3-digit codes after +7). An allow-list on purpose: "+7 727…" is an Almaty landline,
 * and a bare "+77" check would accept it. Update this list when an operator gets a new range.
 */
const KZ_MOBILE_PREFIX = /^\+7(700|701|702|705|707|708|747|750|751|760|761|762|763|771|775|776|777|778)\d{7}$/;

/** Accepts +7, 8 and 7 prefixes for a KZ mobile number; returns E.164 or null. */
export function normalizeKzMobile(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "");
  const e164 = /^\+7\d{10}$/.test(digits) ? digits : /^8\d{10}$/.test(digits) ? `+7${digits.slice(1)}` : /^7\d{10}$/.test(digits) ? `+${digits}` : null;
  return e164 !== null && KZ_MOBILE_PREFIX.test(e164) ? e164 : null;
}

/** The request must come from our own origin. A missing Origin is refused: browsers send it on every fetch POST. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Constant-time string comparison for secrets of equal length. */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** URL-safe random token, 32 bytes by default. */
export function randomToken(bytes = 32, fill: (buf: Uint8Array) => void = (buf) => crypto.getRandomValues(buf)): string {
  const buf = new Uint8Array(bytes);
  fill(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Bounded expiring store (the BFF keeps FastAPI tokens here, never in the browser) ───────────

export class ExpiringStore<T> {
  private readonly items = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? (() => Date.now());
  }

  get(id: string): T | undefined {
    const entry = this.items.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.items.delete(id);
      return undefined;
    }
    return entry.value;
  }

  set(id: string, value: T, ttlMs: number = this.ttlMs): void {
    this.sweep();
    if (!this.items.has(id)) {
      // Bounded memory: when full, the oldest entry is dropped (its owner must sign in again). Never unbounded.
      while (this.items.size >= this.maxEntries) {
        const oldest = this.items.keys().next().value;
        if (oldest === undefined) break;
        this.items.delete(oldest);
      }
    }
    this.items.set(id, { value, expiresAt: this.now() + ttlMs });
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  get size(): number {
    this.sweep();
    return this.items.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
  }
}

// ── Session record and calls on behalf of the parent ────────────────────────────────────────────

export interface ParentSession {
  csrfToken: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms after which the access token must be refreshed before use (with a safety margin). */
  accessExpiresAt: number;
  userId: string;
}

export interface PendingLogin {
  phone: string;
  verificationId: string;
}

/** Refresh this long before the access token really expires, so a request never starts with a dead token. */
export const ACCESS_MARGIN_MS = 30_000;

export class ParentSessionEnded extends Error {
  constructor() {
    super("parent_session_ended");
    this.name = "ParentSessionEnded";
  }
}

export interface ParentCallDeps {
  client: FastapiClient;
  sessions: ExpiringStore<ParentSession>;
  now?: () => number;
  refresh: (client: FastapiClient, refreshToken: string) => Promise<{ access_token: string; refresh_token: string; expires_in_seconds: number }>;
}

/**
 * Runs `fn` with a valid access token of the session:
 *  - refreshes first when the access token is close to expiry;
 *  - on 401 refreshes once and retries once;
 *  - if the refresh token itself is rejected, the session is deleted and ParentSessionEnded is thrown;
 *  - if FastAPI is down, the session is KEPT (it may still be valid) and the FastapiError is rethrown.
 */
export async function callAsParent<T>(deps: ParentCallDeps, sessionId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  const session = deps.sessions.get(sessionId);
  if (!session) throw new ParentSessionEnded();

  const rotate = async (current: ParentSession) => {
    try {
      const fresh = await deps.refresh(deps.client, current.refreshToken);
      const next: ParentSession = {
        ...current,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token,
        accessExpiresAt: now() + fresh.expires_in_seconds * 1000 - ACCESS_MARGIN_MS,
      };
      deps.sessions.set(sessionId, next);
      return next;
    } catch (error) {
      if (error instanceof FastapiError && error.kind === "rejected") {
        deps.sessions.delete(sessionId);
        throw new ParentSessionEnded();
      }
      throw error; // unavailable / timeout / invalid_response: keep the session, report the failure
    }
  };

  let current: ParentSession = session;
  if (now() >= current.accessExpiresAt) current = await rotate(current);

  try {
    return await fn(current.accessToken);
  } catch (error) {
    if (!(error instanceof FastapiError) || error.status !== 401) throw error;
    current = await rotate(current);
    return fn(current.accessToken);
  }
}

// ── Cabinet view model (what the page may show; no tokens, no internal notes) ───────────────────

export type RequestGroup = "waiting" | "confirmed" | "finished" | "cancelled";

export interface CabinetRequest {
  id: string;
  group: RequestGroup;
  statusLabel: string;
  createdAt: string;
  requestedDate: string | null;
  guestCount: number | null;
  branchName: string | null;
  packageName: string | null;
  childName: string | null;
}

export interface ParentCabinet {
  parent: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null };
  children: ParentChild[];
  requests: CabinetRequest[];
}

const STATUS: Record<string, { label: string; group: RequestGroup }> = {
  new: { label: "Ожидает ответа менеджера", group: "waiting" },
  contacted: { label: "Менеджер связался с вами", group: "waiting" },
  qualified: { label: "Уточняем детали", group: "waiting" },
  in_progress: { label: "В работе", group: "waiting" },
  booked: { label: "Бронь подтверждена менеджером", group: "confirmed" },
  confirmed: { label: "Бронь подтверждена менеджером", group: "confirmed" },
  paid: { label: "Подтверждено", group: "confirmed" },
  completed: { label: "Праздник состоялся", group: "finished" },
  closed: { label: "Закрыто", group: "finished" },
  lost: { label: "Не состоялось", group: "cancelled" },
  cancelled: { label: "Отменено", group: "cancelled" },
};

/** Unknown future statuses are shown as "in progress", never as confirmed. */
export function describeStatus(status: string): { label: string; group: RequestGroup } {
  return STATUS[status] ?? { label: "В обработке", group: "waiting" };
}

/** Only birthday requests belong to the cabinet of V1. Newest first. */
export function buildCabinet(profile: ParentProfile, children: ParentChild[], requests: ParentRequest[]): ParentCabinet {
  return {
    parent: { firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone, email: profile.email },
    children,
    requests: requests
      .filter((r) => r.type === "birthday_request")
      .map((r) => {
        const s = describeStatus(r.status);
        return {
          id: r.id,
          group: s.group,
          statusLabel: s.label,
          createdAt: r.createdAt,
          requestedDate: r.requestedDate,
          guestCount: r.guestCount,
          branchName: r.branchName,
          packageName: r.packageName,
          childName: r.childName,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
  };
}

// ── Browser-facing checks for the state-changing BFF routes ─────────────────────────────────────

export type GuardFailure = "forbidden_origin" | "unsupported_media_type" | "forbidden_csrf";

/** Checks applied to every POST the browser can make: same origin, JSON body, and (when given) the session CSRF token. */
export function guardPost(input: {
  origin: string | null;
  host: string | null;
  contentType: string | null;
  csrfHeader?: string | null;
  expectedCsrf?: string;
}): GuardFailure | null {
  if (!isSameOrigin(input.origin, input.host)) return "forbidden_origin";
  if (!(input.contentType ?? "").toLowerCase().startsWith("application/json")) return "unsupported_media_type";
  if (input.expectedCsrf !== undefined && !sameSecret(input.expectedCsrf, input.csrfHeader ?? null)) return "forbidden_csrf";
  return null;
}
