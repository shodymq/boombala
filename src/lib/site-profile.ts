/**
 * The Kazakhstan production profile of the PUBLIC SITE (`SITE_PROFILE=kz-production`). Pure function, no I/O.
 *
 * In that deployment no real enquiry may take an unsafe path, so the two routes that receive personal data (/api/lead,
 * /api/consent) answer 503 and read nothing while any of these problems exists:
 *   - the lead pipeline is not `strict` (any other value can send a name and a phone straight to Telegram from the site);
 *   - the site holds Telegram credentials at all (notifications leave from the staff application only, without name or phone);
 *   - the platform is not on loopback, or the shared secret is missing/short;
 *   - the site holds a secret that belongs to another process.
 * Any other profile (development, tests, Preview, today's production) has no requirements and behaves exactly as before.
 * Problems are CODES; no value of the environment is ever returned or logged.
 */
const FORBIDDEN = ["DATABASE_URL", "MFA_ENC_KEY", "CRON_SECRET", "PLATFORM_IP_PEPPER", "PLATFORM_ROLE", "PLATFORM_PROFILE", "ADMIN_ALLOWED_CIDRS", "SITE_REVALIDATE_URL", "TELEGRAM_NOTIFY_LEVEL"] as const;

/**
 * `SITE_PROFILE=rollback-safe`: the site as it runs on the temporary rollback deployment (the one DNS may be pointed back
 * to if the Kazakhstan server fails). Pages are served; the forms ALWAYS refuse, so a rollback never sends a name or a phone
 * anywhere (not to Telegram, not to the platform). Anything that could would also be reported, even though the forms
 * refuse already: the rollback project must not hold Telegram credentials or a platform address at all.
 */
function rollbackSafeProblems(env: Record<string, string | undefined>): string[] {
  const p = ["rollback_forms_disabled"];
  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID || env.TELEGRAM_API_BASE) p.push("site_must_not_hold_telegram_credentials");
  for (const k of ["PLATFORM_URL", "PLATFORM_INTAKE_TOKEN", ...FORBIDDEN] as const) if (env[k]) p.push(`site_must_not_have_${k.toLowerCase()}`);
  return p;
}

export function siteProfileProblems(env: Record<string, string | undefined> = process.env): string[] {
  if (env.SITE_PROFILE === "rollback-safe") return rollbackSafeProblems(env);
  if (env.SITE_PROFILE !== "kz-production") return [];
  const p: string[] = [];
  if ((env.LEAD_PIPELINE ?? "").trim() !== "strict") p.push("lead_pipeline_must_be_strict");
  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID || env.TELEGRAM_API_BASE) p.push("site_must_not_hold_telegram_credentials");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test((env.PLATFORM_URL ?? "").trim())) p.push("platform_url_must_be_loopback");
  if ((env.PLATFORM_INTAKE_TOKEN ?? "").trim().length < 24) p.push("intake_token_required");
  for (const k of FORBIDDEN) if (env[k]) p.push(`site_must_not_have_${k.toLowerCase()}`);
  return p;
}

/** Logs the codes once per call site and tells the route whether it must refuse. */
export function siteMustRefuse(route: string): boolean {
  const problems = siteProfileProblems();
  if (problems.length === 0) return false;
  console.error(JSON.stringify({ event: "site.profile_invalid", route, problems }));
  return true;
}
