/**
 * What this process is allowed to expose, decided before any page or handler runs. Pure functions (no Next, no I/O):
 * `proxy.ts` applies them to every request, tests call them directly.
 *
 * Two deployments of ONE code base, with separate secrets, separate database roles and separate hosts:
 *   PLATFORM_ROLE=api    the public API: health, intake, public reads. Nothing else exists on it (not even /login).
 *   PLATFORM_ROLE=admin  the staff application: login, pages, admin APIs. It answers only on the admin host, only to
 *                        requests that arrive from the VPN network, and has no public intake.
 *   PLATFORM_ROLE=all    development, tests and the current Preview: everything, as before.
 *
 * Network isolation (WireGuard, firewall, nginx bound to the VPN address) is the first wall; this is the second, so a
 * mistake in the first one does not expose the admin. Unknown paths and wrong hosts answer 404/421, never a login page.
 */

export type PlatformRole = "admin" | "api" | "all";

export function parseRole(value: string | undefined): PlatformRole {
  return value === "admin" || value === "api" ? value : "all";
}

export type PathClass = "health" | "public_api" | "admin";

/** The health check is allowed everywhere; intake and public reads belong to the API; everything else is admin. */
export function classifyPath(pathname: string): PathClass {
  if (pathname === "/api/health") return "health";
  if (pathname.startsWith("/api/intake/") || pathname.startsWith("/api/public/")) return "public_api";
  return "admin";
}

// ── CIDR matching (IPv4 and IPv6) ─────────────────────────────────────────────────────────────────────────────

function ipToBigInt(ip: string): { v: bigint; bits: 32 | 128 } | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { v: BigInt(((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0), bits: 32 };
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return ipToBigInt(mapped[1]);
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n), bits: 128 };
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, lenText] = cidr.trim().split("/");
  const a = ipToBigInt(ip.trim());
  const b = ipToBigInt(base ?? "");
  if (!a || !b || a.bits !== b.bits) return false;
  const len = lenText === undefined ? b.bits : Number(lenText);
  if (!Number.isInteger(len) || len < 0 || len > b.bits) return false;
  const shift = BigInt(b.bits - len);
  return a.v >> shift === b.v >> shift;
}

export function validCidr(cidr: string): boolean {
  const [base, lenText] = cidr.trim().split("/");
  const b = ipToBigInt(base ?? "");
  if (!b) return false;
  if (lenText === undefined) return true;
  const len = Number(lenText);
  return Number.isInteger(len) && len >= 0 && len <= b.bits;
}

export const splitList = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ── The decision ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ExposureConfig {
  role: PlatformRole;
  /** Host names this process answers to (with port when not default). Empty = no host check (development only). */
  allowedHosts: string[];
  /** Source networks allowed to reach the ADMIN (VPN subnet, loopback for the local timer). Empty = no check (development only). */
  adminCidrs: string[];
}

export interface ExposureRequest {
  pathname: string;
  /** The Host the visitor asked for (x-forwarded-host, else host). */
  host: string | null;
  /** The client address as written by the reverse proxy (X-Real-IP): the app itself listens on loopback only. */
  realIp: string | null;
}

export type ExposureDecision = { allow: true } | { allow: false; status: 404 | 421; reason: "host" | "role" | "network" };

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

export function decideExposure(cfg: ExposureConfig, req: ExposureRequest): ExposureDecision {
  if (cfg.allowedHosts.length > 0) {
    const host = req.host ? normHost(req.host) : "";
    if (!host || !cfg.allowedHosts.includes(host)) return { allow: false, status: 421, reason: "host" };
  }
  const cls = classifyPath(req.pathname);
  if (cls !== "health") {
    if (cfg.role === "api" && cls !== "public_api") return { allow: false, status: 404, reason: "role" };
    if (cfg.role === "admin" && cls !== "admin") return { allow: false, status: 404, reason: "role" };
  }
  // The admin application (and, in a shared deployment, its pages) is reachable only from the VPN networks. The health
  // check of the admin is included: a stranger must learn nothing, not even that something answers there.
  if ((cfg.role === "admin" || (cfg.role === "all" && cls === "admin")) && cfg.adminCidrs.length > 0) {
    const ip = req.realIp?.trim() ?? "";
    if (!ip || !cfg.adminCidrs.some((c) => ipInCidr(ip, c))) return { allow: false, status: 404, reason: "network" };
  }
  return { allow: true };
}

export function exposureFromEnv(env: Record<string, string | undefined> = process.env): ExposureConfig {
  return { role: parseRole(env.PLATFORM_ROLE), allowedHosts: splitList(env.ALLOWED_HOSTS), adminCidrs: (env.ADMIN_ALLOWED_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean) };
}

// ── The production profile: refuse to run misconfigured ───────────────────────────────────────────────────────

/** Variables that must exist ONLY in one of the deployments (secret separation). */
const ADMIN_ONLY = ["MFA_ENC_KEY", "CRON_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_NOTIFY_LEVEL", "REVALIDATE_TOKEN", "SITE_REVALIDATE_URL"] as const;
const API_ONLY = ["PLATFORM_INTAKE_TOKEN", "PLATFORM_IP_PEPPER"] as const;

/**
 * Problems of an environment that claims to be `kz-production`. Empty list = acceptable. Any other profile has no
 * requirements (development, tests, Preview). The app answers 503 to every request while the list is not empty
 * (fail closed) and logs the codes, never values.
 */
export function profileProblems(env: Record<string, string | undefined> = process.env): string[] {
  if (env.PLATFORM_PROFILE !== "kz-production") return [];
  const p: string[] = [];
  const role = env.PLATFORM_ROLE;
  if (role !== "admin" && role !== "api") p.push("role_must_be_admin_or_api");
  if (env.PLATFORM_HTTPS !== "1") p.push("https_required");
  if (splitList(env.ALLOWED_HOSTS).length === 0) p.push("allowed_hosts_required");
  if (!env.DATABASE_URL) p.push("database_url_required");
  if (role === "admin") {
    if (env.MFA_MODE !== "required") p.push("mfa_required");
    if (env.PASSKEY_MODE !== "required") p.push("passkey_required");
    if (!env.WEBAUTHN_RP_ID) p.push("webauthn_rp_id_required");
    if (!env.WEBAUTHN_ORIGIN || !/^https:\/\//i.test(env.WEBAUTHN_ORIGIN)) p.push("webauthn_origin_invalid");
    if (Buffer.from(env.MFA_ENC_KEY ?? "", "base64").length !== 32) p.push("mfa_key_invalid");
    const cidrs = (env.ADMIN_ALLOWED_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (cidrs.length === 0) p.push("admin_cidrs_required");
    if (cidrs.some((c) => !validCidr(c))) p.push("admin_cidrs_invalid");
    if (cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0" || /\/([0-7])$/.test(c))) p.push("admin_cidrs_too_wide");
    if (!env.CRON_SECRET) p.push("cron_secret_required");
    // Notifications in production never carry a name or a phone: the message says "new enquiry N", the details are in the CRM.
    if (env.TELEGRAM_NOTIFY_LEVEL !== "minimal") p.push("notify_level_must_be_minimal");
    for (const k of API_ONLY) if (env[k]) p.push(`admin_must_not_have_${k.toLowerCase()}`);
  }
  if (role === "api") {
    if (!env.PLATFORM_INTAKE_TOKEN || env.PLATFORM_INTAKE_TOKEN.length < 24) p.push("intake_token_required");
    for (const k of ADMIN_ONLY) if (env[k]) p.push(`api_must_not_have_${k.toLowerCase()}`);
    if (env.ADMIN_ALLOWED_CIDRS) p.push("api_must_not_have_admin_cidrs");
  }
  return p;
}
