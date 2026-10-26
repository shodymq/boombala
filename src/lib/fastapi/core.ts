/**
 * Pure part of the FastAPI client for the public site: contract types, config parsing, request
 * correlation, PII-safe logging and the HTTP call itself. No "server-only" import here so that
 * scripts/fastapi-core.test.ts can run it under node; the server entry point is ./index.ts.
 *
 * Contract source: BoomBalaApp backend (FastAPI), routers under the /api/v1 prefix:
 *   POST /mobile/leads/contact, POST /mobile/leads/birthday, POST /mobile/auth/request-otp,
 *   POST /mobile/auth/verify-otp. Mirrors the schemas in backend/app/modules/ at BoomBalaApp 9b65ae5.
 */

// ── Feature flags ───────────────────────────────────────────────────────────────────────────────

/** Each capability is switched on separately. Default is nothing: the site keeps its current routes. */
export const FASTAPI_FEATURES = ["leads", "otp", "account"] as const;
export type FastapiFeature = (typeof FASTAPI_FEATURES)[number];

/**
 * FASTAPI_FEATURES=leads,otp  (comma list). Unknown names are ignored on purpose: a typo must not
 * silently enable anything, and must not crash the site either.
 */
export function enabledFeatures(raw: string | undefined): ReadonlySet<FastapiFeature> {
  const wanted = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is FastapiFeature => (FASTAPI_FEATURES as readonly string[]).includes(s));
  return new Set(wanted);
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────────

export interface FastapiConfig {
  /** Origin + prefix, e.g. https://api-staging.example.kz/api/v1 . Never ends with "/". */
  baseUrl: string;
  timeoutMs: number;
  features: ReadonlySet<FastapiFeature>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Returns null when no feature is enabled, so the client is inert by default.
 * Throws only when a feature IS enabled and the URL is unsafe: a half-configured integration must fail loudly
 * at startup, not send personal data to a wrong host.
 */
export function parseFastapiConfig(env: Record<string, string | undefined>): FastapiConfig | null {
  const features = enabledFeatures(env.FASTAPI_FEATURES);
  if (features.size === 0) return null;

  const baseUrl = (env.FASTAPI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const secureUrl = /^https:\/\/[^/\s@]+(\/[^\s?#]*)?$/.test(baseUrl); // no user:pass@ in the URL
  const localUrl = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s?#]*)?$/.test(baseUrl);
  if (!secureUrl && !localUrl) throw new FastapiError("not_configured");

  const timeoutRaw = Number(env.FASTAPI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(Math.max(timeoutRaw, 500), 10_000) : DEFAULT_TIMEOUT_MS;

  return { baseUrl, timeoutMs, features };
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

/**
 * kind:
 *  - not_configured  base URL missing or unsafe while a feature is on
 *  - disabled        the capability is switched off by its flag (no network call was made)
 *  - timeout         no answer within timeoutMs
 *  - unavailable     network failure or 5xx
 *  - rejected        4xx; `code` holds FastAPI's error code (never the message, which may echo input)
 *  - invalid_response 2xx whose body does not match the contract
 */
export type FastapiFailure = "not_configured" | "disabled" | "timeout" | "unavailable" | "rejected" | "invalid_response";

export class FastapiError extends Error {
  readonly kind: FastapiFailure;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(kind: FastapiFailure, status?: number, code?: string, requestId?: string) {
    super(`fastapi:${kind}${code ? `:${code}` : ""}`);
    this.name = "FastapiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

// ── Contract types (mirror FastAPI schemas; keep field names identical to the JSON) ─────────────

export interface ContactLeadCreate {
  name: string;
  phone: string;
  message?: string | null;
  email?: string | null;
}

export interface LeadCreatedResponse {
  id: string;
  type: string;
  status: string;
}

export interface BirthdayLeadCreate {
  name: string;
  phone: string;
  branchId: string;
  preferredDate?: string | null;
  guestCount?: number | null;
  comment?: string | null;
  packageId?: string | null;
  childId?: string | null;
  sourceCampaignId?: string | null;
  birthdayCycleId?: string | null;
  idempotencyKey?: string | null;
}

export interface BirthdayLeadSubmittedResponse {
  requestId: string;
  submittedAt: string;
  nextStep: string;
}

export interface OtpRequest {
  phone: string;
}

export interface OtpRequestResponse {
  verification_id: string;
  expires_in_seconds: number;
  resend_after_seconds: number;
}

export interface OtpVerifyRequest {
  phone: string;
  code: string;
  verification_id: string;
}

/**
 * Returned by verify-otp. It carries bearer and refresh tokens: the caller must keep them in the
 * server-side session only. Never serialise this object to the browser.
 */
export interface MobileAuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in_seconds: number;
  refresh_expires_in_seconds: number;
  user: { id: string; phone: string | null; email: string | null };
}

// ── Runtime checks of responses (the contract is enforced, not trusted) ────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseLeadCreated(v: unknown): LeadCreatedResponse {
  if (!isObject(v) || !isString(v.id) || !isString(v.type) || !isString(v.status)) throw new FastapiError("invalid_response");
  return { id: v.id, type: v.type, status: v.status };
}

export function parseBirthdayLeadSubmitted(v: unknown): BirthdayLeadSubmittedResponse {
  if (!isObject(v) || !isString(v.requestId) || !isString(v.submittedAt) || !isString(v.nextStep)) {
    throw new FastapiError("invalid_response");
  }
  return { requestId: v.requestId, submittedAt: v.submittedAt, nextStep: v.nextStep };
}

export function parseOtpRequested(v: unknown): OtpRequestResponse {
  if (!isObject(v) || !isString(v.verification_id) || !isNumber(v.expires_in_seconds) || !isNumber(v.resend_after_seconds)) {
    throw new FastapiError("invalid_response");
  }
  return {
    verification_id: v.verification_id,
    expires_in_seconds: v.expires_in_seconds,
    resend_after_seconds: v.resend_after_seconds,
  };
}

export function parseMobileAuth(v: unknown): MobileAuthResponse {
  if (
    !isObject(v) ||
    !isString(v.access_token) ||
    !isString(v.refresh_token) ||
    !isObject(v.user) ||
    !isString(v.user.id) ||
    !isNumber(v.expires_in_seconds) ||
    !isNumber(v.refresh_expires_in_seconds)
  ) {
    throw new FastapiError("invalid_response");
  }
  return {
    access_token: v.access_token,
    refresh_token: v.refresh_token,
    token_type: typeof v.token_type === "string" ? v.token_type : "bearer",
    expires_in_seconds: v.expires_in_seconds,
    refresh_expires_in_seconds: v.refresh_expires_in_seconds,
    user: {
      id: v.user.id,
      phone: typeof v.user.phone === "string" ? v.user.phone : null,
      email: typeof v.user.email === "string" ? v.user.email : null,
    },
  };
}

// ── Correlation and logging ─────────────────────────────────────────────────────────────────────

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Accepts an incoming id only if it is short and plain; otherwise issues a new one. */
export function correlationId(incoming: string | null | undefined, generate: () => string = () => crypto.randomUUID()): string {
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : generate();
}

/** Keys that carry personal data or secrets. They are removed from anything that may be logged. */
const SENSITIVE_KEYS = new Set([
  "name",
  "phone",
  "email",
  "comment",
  "message",
  "code",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "childId",
  "preferredDate",
  "idempotencyKey",
]);

/** Shallow-clones a value and replaces every sensitive key with "[redacted]". Safe for diagnostics only. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[redacted]" : redact(v)]),
  );
}

export interface FastapiLogLine {
  event: "fastapi.call";
  requestId: string;
  /** Path template only, e.g. "/mobile/leads/birthday". Never includes query strings or IDs. */
  route: string;
  status?: number;
  outcome: "ok" | FastapiFailure;
  durationMs: number;
}

export type FastapiLogger = (line: FastapiLogLine) => void;

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  method: "GET" | "POST";
  route: string;
  /** Access token of the parent, sent as Bearer. Only the server-side BFF ever passes it. */
  bearer?: string;
  body?: unknown;
  feature: FastapiFeature;
  requestId?: string;
}

export interface FastapiClientDeps {
  config: FastapiConfig | null;
  fetchImpl?: FetchLike;
  logger?: FastapiLogger;
  now?: () => number;
  newId?: () => string;
}

export interface FastapiClient {
  call<T>(options: CallOptions, parse: (v: unknown) => T): Promise<T>;
  readonly enabled: (feature: FastapiFeature) => boolean;
}

export function createFastapiClient(deps: FastapiClientDeps): FastapiClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log: FastapiLogger = deps.logger ?? (() => {});
  const config = deps.config;

  const enabled = (feature: FastapiFeature) => config !== null && config.features.has(feature);

  return {
    enabled,
    async call<T>(options: CallOptions, parse: (v: unknown) => T): Promise<T> {
      const requestId = correlationId(options.requestId, newId);
      const started = now();
      const finish = (outcome: FastapiLogLine["outcome"], status?: number) =>
        log({ event: "fastapi.call", requestId, route: options.route, status, outcome, durationMs: now() - started });

      if (!config) {
        finish("not_configured");
        throw new FastapiError("not_configured", undefined, undefined, requestId);
      }
      if (!config.features.has(options.feature)) {
        finish("disabled");
        throw new FastapiError("disabled", undefined, undefined, requestId);
      }

      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}${options.route}`, {
          method: options.method,
          headers: {
            accept: "application/json",
            "x-request-id": requestId,
            ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(config.timeoutMs),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const kind: FastapiFailure = timedOut ? "timeout" : "unavailable";
        finish(kind);
        throw new FastapiError(kind, undefined, undefined, requestId); // original error may contain the URL
      }

      const data: unknown = await res.json().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) {
        try {
          const parsed = parse(data);
          finish("ok", res.status);
          return parsed;
        } catch (error) {
          finish("invalid_response", res.status);
          throw error instanceof FastapiError ? new FastapiError("invalid_response", res.status, undefined, requestId) : error;
        }
      }

      if (res.status >= 500) {
        finish("unavailable", res.status);
        throw new FastapiError("unavailable", res.status, undefined, requestId);
      }

      const code = isObject(data) && isObject(data.error) && isString(data.error.code) ? data.error.code : undefined;
      finish("rejected", res.status);
      throw new FastapiError("rejected", res.status, code, requestId);
    },
  };
}

// ── Typed endpoint wrappers (no UI calls them yet; the production forms keep their current routes) ──

export const ENDPOINTS = {
  contactLead: "/mobile/leads/contact",
  birthdayLead: "/mobile/leads/birthday",
  requestOtp: "/mobile/auth/request-otp",
  verifyOtp: "/mobile/auth/verify-otp",
} as const;

export function postContactLead(client: FastapiClient, body: ContactLeadCreate, requestId?: string) {
  return client.call({ method: "POST", route: ENDPOINTS.contactLead, body, feature: "leads", requestId }, parseLeadCreated);
}

export function postBirthdayLead(client: FastapiClient, body: BirthdayLeadCreate, requestId?: string) {
  return client.call(
    { method: "POST", route: ENDPOINTS.birthdayLead, body, feature: "leads", requestId },
    parseBirthdayLeadSubmitted,
  );
}

export function requestOtp(client: FastapiClient, body: OtpRequest, requestId?: string) {
  return client.call({ method: "POST", route: ENDPOINTS.requestOtp, body, feature: "otp", requestId }, parseOtpRequested);
}

export function verifyOtp(client: FastapiClient, body: OtpVerifyRequest, requestId?: string) {
  return client.call({ method: "POST", route: ENDPOINTS.verifyOtp, body, feature: "otp", requestId }, parseMobileAuth);
}

// ── Parent account (feature "account"): all calls carry the parent's own Bearer token ────────────

export interface ParentProfile {
  id: string;
  phone: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  onboardingCompleted: boolean;
}

export type ChildGenderValue = "male" | "female" | "unspecified";

export interface ParentChild {
  id: string;
  name: string;
  birthDate: string;
  gender: ChildGenderValue;
}

/** One request of the parent. `notes` is deliberately not part of the contract used by the site (staff-facing text). */
export interface ParentRequest {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  requestedDate: string | null;
  guestCount: number | null;
  branchName: string | null;
  packageName: string | null;
  childName: string | null;
}

const optString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const optNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseProfile(v: unknown): ParentProfile {
  if (!isObject(v) || !isString(v.id)) throw new FastapiError("invalid_response");
  return {
    id: v.id,
    phone: optString(v.phone),
    email: optString(v.email),
    firstName: optString(v.firstName),
    lastName: optString(v.lastName),
    onboardingCompleted: v.onboardingCompleted === true,
  };
}

export function parseChildren(v: unknown): ParentChild[] {
  if (!isObject(v) || !Array.isArray(v.items)) throw new FastapiError("invalid_response");
  return v.items.map((c) => {
    if (!isObject(c) || !isString(c.id) || !isString(c.name) || !isString(c.birthDate)) throw new FastapiError("invalid_response");
    const gender: ChildGenderValue = c.gender === "male" || c.gender === "female" ? c.gender : "unspecified";
    return { id: c.id, name: c.name, birthDate: c.birthDate, gender };
  });
}

export function parseRequests(v: unknown): ParentRequest[] {
  if (!isObject(v) || !Array.isArray(v.items)) throw new FastapiError("invalid_response");
  return v.items.map((r) => {
    if (!isObject(r) || !isString(r.id) || !isString(r.type) || !isString(r.status) || !isString(r.createdAt)) {
      throw new FastapiError("invalid_response");
    }
    const branch = isObject(r.branch) ? optString(r.branch.name) : null;
    const pkg = isObject(r.package) ? optString(r.package.name) : null;
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      createdAt: r.createdAt,
      requestedDate: optString(r.requestedDate),
      guestCount: optNumber(r.guestCount),
      branchName: branch,
      packageName: pkg,
      childName: optString(r.childName),
    };
  });
}

export const ACCOUNT_ENDPOINTS = {
  refresh: "/mobile/auth/refresh",
  logout: "/mobile/auth/logout",
  profile: "/mobile/me",
  children: "/mobile/me/children",
  requests: "/mobile/me/requests",
} as const;

export function refreshTokens(client: FastapiClient, refreshToken: string, requestId?: string) {
  return client.call(
    { method: "POST", route: ACCOUNT_ENDPOINTS.refresh, body: { refresh_token: refreshToken }, feature: "account", requestId },
    parseMobileAuth,
  );
}

export function logoutTokens(client: FastapiClient, accessToken: string, requestId?: string) {
  return client.call(
    { method: "POST", route: ACCOUNT_ENDPOINTS.logout, feature: "account", bearer: accessToken, requestId },
    () => undefined,
  );
}

export function getProfile(client: FastapiClient, accessToken: string, requestId?: string) {
  return client.call({ method: "GET", route: ACCOUNT_ENDPOINTS.profile, feature: "account", bearer: accessToken, requestId }, parseProfile);
}

export function getChildren(client: FastapiClient, accessToken: string, requestId?: string) {
  return client.call({ method: "GET", route: ACCOUNT_ENDPOINTS.children, feature: "account", bearer: accessToken, requestId }, parseChildren);
}

export function getRequests(client: FastapiClient, accessToken: string, requestId?: string) {
  return client.call({ method: "GET", route: ACCOUNT_ENDPOINTS.requests, feature: "account", bearer: accessToken, requestId }, parseRequests);
}
