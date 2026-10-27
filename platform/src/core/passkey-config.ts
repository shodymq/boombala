/**
 * Where passkeys may be used. Pure functions (no I/O): the proxy, the startup checks and the tests all call them.
 *
 * A passkey is bound to the RP ID (a registrable host name) and to the exact origins (scheme + host + port) it is used on.
 * Both come ONLY from the environment, never from the request: a visitor cannot choose where the credential is valid.
 *   PASSKEYS_ENABLED=1
 *   WEBAUTHN_RP_ID=admin.example.kz               host name, no scheme, no port, no path
 *   WEBAUTHN_ORIGINS=https://admin.example.kz     comma-separated, https only (http://localhost is accepted outside production)
 */
export interface PasskeyConfig {
  enabled: boolean;
  rpID: string;
  rpName: string;
  origins: string[];
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function passkeyConfigFromEnv(env: Record<string, string | undefined> = process.env): PasskeyConfig {
  return {
    enabled: env.PASSKEYS_ENABLED === "1",
    rpID: (env.WEBAUTHN_RP_ID ?? "").trim().toLowerCase(),
    rpName: (env.WEBAUTHN_RP_NAME ?? "Boom Bala").trim().slice(0, 60) || "Boom Bala",
    origins: (env.WEBAUTHN_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * Problems of an enabled configuration (codes only, never values). Empty = acceptable. `production` = the Kazakhstan profile:
 * https is mandatory there and plain-http localhost is refused.
 */
export function passkeyConfigProblems(cfg: PasskeyConfig, opts: { production: boolean }): string[] {
  if (!cfg.enabled) return [];
  const p: string[] = [];
  if (!HOST.test(cfg.rpID) || /^\d+(\.\d+){3}$/.test(cfg.rpID)) p.push("webauthn_rp_id_invalid");
  if (cfg.origins.length === 0) p.push("webauthn_origins_required");
  for (const o of cfg.origins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      p.push("webauthn_origin_invalid");
      continue;
    }
    const plainLocal = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && !opts.production;
    if (u.protocol !== "https:" && !plainLocal) p.push("webauthn_origin_must_be_https");
    if (u.origin !== o || u.username || u.password) p.push("webauthn_origin_must_be_origin_only");
    if (u.hostname !== cfg.rpID && !u.hostname.endsWith(`.${cfg.rpID}`)) p.push("webauthn_origin_outside_rp_id");
  }
  return [...new Set(p)];
}
