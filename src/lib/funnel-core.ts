/**
 * Pure helpers for the birthday conversion funnel (no DOM, no aliases, unit-testable with node:test).
 *
 * Privacy rule: an event may carry ONLY the five whitelisted keys below. Anything else a caller passes
 * (name, phone, dates, free text, tokens...) is dropped, and every value is normalised to a short
 * [a-z0-9_-] token, so personal data cannot leak through a mistake at a call site.
 */

export const BIRTHDAY_EVENTS = [
  "birthday_package_select",
  "birthday_room_open",
  "birthday_room_select",
  "birthday_lead_form_open",
  "birthday_lead_submit_attempt",
  "birthday_lead_success",
  "birthday_lead_error",
] as const;
export type BirthdayEvent = (typeof BIRTHDAY_EVENTS)[number];

export const ERROR_TYPES = [
  "validation_client", // blocked in the browser (missing/invalid field)
  "validation_server", // API answered 400
  "forbidden", // 403
  "rate_limited", // 429
  "delivery_failed", // 502: Telegram did not accept the lead
  "not_configured", // 503: server has no Telegram credentials
  "server_error", // 500
  "network", // request failed / timed out
  "other",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export interface BirthdayParams {
  package_id?: string;
  room_id?: string;
  cta_source?: string;
  page_path?: string;
  error_type?: string;
}

export interface Allowed {
  packages: readonly string[];
  rooms: readonly string[];
}

const token = (v: unknown, max: number, fallback: string) => {
  if (typeof v !== "string") return fallback;
  const t = v.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return t || fallback;
};

/** "/birthdays?utm=x#rooms" -> "/birthdays". Never includes a query string or fragment. */
export function cleanPath(v: unknown): string {
  if (typeof v !== "string") return "/";
  const path = v.split(/[?#]/)[0];
  return /^\/[A-Za-z0-9/_-]{0,79}$/.test(path) ? path : "/";
}

export function sanitizeBirthdayParams(raw: Record<string, unknown> | undefined, allowed: Allowed): Required<BirthdayParams> {
  const r = raw ?? {};
  const pkg = typeof r.package_id === "string" ? r.package_id : "";
  const room = typeof r.room_id === "string" ? r.room_id : "";
  return {
    package_id: !pkg ? "none" : allowed.packages.includes(pkg) ? pkg : "unknown",
    room_id: !room ? "none" : allowed.rooms.includes(room) ? room : "unknown",
    cta_source: token(r.cta_source, 40, "unknown"),
    page_path: cleanPath(r.page_path),
    error_type: typeof r.error_type === "string" && (ERROR_TYPES as readonly string[]).includes(r.error_type) ? r.error_type : r.error_type ? "other" : "none",
  };
}

/** Drops an identical event repeated within `windowMs` (double click, React Strict Mode, re-render). */
export function createDeduper(windowMs = 800, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    for (const [k, at] of seen) if (t - at > windowMs * 4) seen.delete(k);
    const last = seen.get(key);
    seen.set(key, t);
    return last === undefined || t - last > windowMs;
  };
}

/** Map an HTTP status of POST /api/lead to an error_type. */
export function errorTypeFromStatus(status: number): ErrorType {
  if (status === 400) return "validation_server";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 502) return "delivery_failed";
  if (status === 503) return "not_configured";
  if (status >= 500) return "server_error";
  return "other";
}
