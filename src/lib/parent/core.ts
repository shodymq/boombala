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
  | "session_store_not_configured"
  | "production_otp_not_ready";

export type ParentLoginState = { enabled: true } | { enabled: false; reason: ParentLoginOffReason };

const off = (reason: ParentLoginOffReason): ParentLoginState => ({ enabled: false, reason });

const LOOPBACK_OR_HTTPS = /^(https:\/\/[^/\s@]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/[^\s?#]*)?$/;

/**
 * Parent login needs every piece below, and is closed in production regardless:
 *  - PARENT_LOGIN=on, the FastAPI features `otp` and `account`, and a valid FastAPI URL;
 *  - a shared session store: the platform's internal API (PLATFORM_URL, PARENT_SESSION_SERVICE_TOKEN) and the key that seals
 *    the pending phone login (PARENT_PENDING_KEY). Without the store nothing can be created, so nothing is enabled;
 *  - production: OFF. There is no real SMS provider yet (backend OTP is mock by default), so the site must not offer login.
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
  const platformUrl = (env.PLATFORM_URL ?? "").trim();
  const token = (env.PARENT_SESSION_SERVICE_TOKEN ?? "").trim();
  const pending = (env.PARENT_PENDING_KEY ?? "").trim();
  const pendingOk = /^[A-Za-z0-9+/]+={0,2}$/.test(pending) && Buffer.from(pending, "base64").length === 32;
  if (!LOOPBACK_OR_HTTPS.test(platformUrl) || token.length < 24 || !pendingOk) return off("session_store_not_configured");
  if (env.NODE_ENV === "production") return off("production_otp_not_ready");
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

/** One parent session as the store keeps it (tokens included; they never leave the server). */
export interface SessionRecord {
  userId: string;
  csrf: string;
  access: string;
  refresh: string;
  /** Epoch ms after which the access token must be refreshed before use (with a safety margin). */
  accessExpiresAt: number;
}

export type ParentSession = SessionRecord;

export interface TokenUpdate {
  access: string;
  refresh: string;
  accessExpiresAt: number;
}

/**
 * Shared, server-side session storage (see session-store.ts). Every method may throw SessionStoreUnavailable: the caller
 * fails closed and never assumes a session is valid or invalid when the store cannot answer.
 */
export interface SessionStore {
  create(sid: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  lookup(sid: string): Promise<SessionRecord | null>;
  rotate(sid: string, update: TokenUpdate): Promise<boolean>;
  revoke(sid: string): Promise<void>;
}

export class SessionStoreUnavailable extends Error {
  constructor() {
    super("parent_session_store_unavailable");
    this.name = "SessionStoreUnavailable";
  }
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
  store: SessionStore;
  now?: () => number;
  refresh: (client: FastapiClient, refreshToken: string) => Promise<{ access_token: string; refresh_token: string; expires_in_seconds: number }>;
}

/**
 * Runs `fn` with a valid access token of the session:
 *  - refreshes first when the access token is at or past its (margin-adjusted) deadline;
 *  - on 401 refreshes once and retries once;
 *  - a rejected refresh token revokes the session and throws ParentSessionEnded;
 *  - FastAPI down keeps the session and rethrows the FastapiError;
 *  - the store down throws SessionStoreUnavailable (fail closed).
 */
export async function callAsParent<T>(deps: ParentCallDeps, sessionId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  let current = await deps.store.lookup(sessionId);
  if (!current) throw new ParentSessionEnded();

  const rotate = async (session: SessionRecord): Promise<SessionRecord> => {
    let fresh: { access_token: string; refresh_token: string; expires_in_seconds: number };
    try {
      fresh = await deps.refresh(deps.client, session.refresh);
    } catch (error) {
      if (error instanceof FastapiError && error.kind === "rejected") {
        await deps.store.revoke(sessionId);
        throw new ParentSessionEnded();
      }
      throw error; // unavailable / timeout / invalid_response: keep the session, report the failure
    }
    const update: TokenUpdate = {
      access: fresh.access_token,
      refresh: fresh.refresh_token,
      accessExpiresAt: now() + fresh.expires_in_seconds * 1000 - ACCESS_MARGIN_MS,
    };
    if (!(await deps.store.rotate(sessionId, update))) throw new ParentSessionEnded();
    return { ...session, ...update };
  };

  if (now() >= current.accessExpiresAt) current = await rotate(current);
  try {
    return await fn(current.access);
  } catch (error) {
    if (!(error instanceof FastapiError) || error.status !== 401) throw error;
    current = await rotate(current);
    return fn(current.access);
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
