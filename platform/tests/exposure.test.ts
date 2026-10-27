import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPath, decideExposure, exposureFromEnv, ipInCidr, parseRole, profileProblems, validCidr, type ExposureConfig } from "../src/server/exposure.ts";

const VPN = "10.77.0.0/24";
const admin: ExposureConfig = { role: "admin", allowedHosts: ["panel.example.test"], adminCidrs: [VPN, "127.0.0.1/32"] };
const api: ExposureConfig = { role: "api", allowedHosts: ["api.example.test"], adminCidrs: [] };
const req = (pathname: string, host: string | null, realIp: string | null) => ({ pathname, host, realIp });

describe("Exposure: what each deployment shows", () => {
  describe("path classes", () => {
    it("health, public API and admin", () => {
      assert.equal(classifyPath("/api/health"), "health");
      for (const p of ["/api/intake/lead", "/api/intake/consent", "/api/public/news", "/api/public/availability", "/api/public/legal"]) assert.equal(classifyPath(p), "public_api", p);
      for (const p of ["/", "/login", "/login/mfa", "/contacts", "/contacts/abc", "/requests", "/bookings", "/news", "/export", "/retention", "/users", "/audit", "/api/export", "/api/media", "/api/media/x", "/api/cron/outbox", "/api/healthz", "/api/intakeX", "/anything"]) assert.equal(classifyPath(p), "admin", p);
    });
    it("lookalikes of the public prefixes are admin, not public", () => {
      for (const p of ["/api/intake", "/api/public", "/api/publicx/a", "//api/intake/lead", "/api/INTAKE/lead"]) assert.equal(classifyPath(p), "admin", p);
    });
  });

  describe("CIDR matching", () => {
    it("IPv4", () => {
      assert.equal(ipInCidr("10.77.0.5", VPN), true);
      assert.equal(ipInCidr("10.77.0.255", VPN), true);
      assert.equal(ipInCidr("10.77.1.5", VPN), false);
      assert.equal(ipInCidr("10.78.0.5", VPN), false);
      assert.equal(ipInCidr("127.0.0.1", "127.0.0.1/32"), true);
      assert.equal(ipInCidr("127.0.0.2", "127.0.0.1/32"), false);
      assert.equal(ipInCidr("203.0.113.9", "0.0.0.0/0"), true);
      assert.equal(ipInCidr("203.0.113.9", "10.77.0.0"), false, "no length means a single address");
    });
    it("IPv6 and IPv4-mapped", () => {
      assert.equal(ipInCidr("fd00:77::5", "fd00:77::/64"), true);
      assert.equal(ipInCidr("fd00:78::5", "fd00:77::/64"), false);
      assert.equal(ipInCidr("::1", "::1/128"), true);
      assert.equal(ipInCidr("::ffff:10.77.0.5", VPN), true);
      assert.equal(ipInCidr("10.77.0.5", "fd00:77::/64"), false, "families never match each other");
    });
    it("garbage never matches", () => {
      for (const bad of ["", "unknown", "10.77.0", "10.77.0.256", "10.77.0.5, 1.1.1.1", "fd00::zz", "1::2::3", "10.77.0.5/24"]) assert.equal(ipInCidr(bad, VPN), false, JSON.stringify(bad));
      assert.equal(ipInCidr("10.77.0.5", "10.77.0.0/33"), false);
      assert.equal(ipInCidr("10.77.0.5", "nonsense/24"), false);
      assert.equal(validCidr("10.77.0.0/24"), true);
      assert.equal(validCidr("10.77.0.0/40"), false);
      assert.equal(validCidr("x"), false);
    });
  });

  describe("the admin deployment", () => {
    it("answers only on its own host, only from the VPN, only with admin paths", () => {
      assert.deepEqual(decideExposure(admin, req("/login", "panel.example.test", "10.77.0.5")), { allow: true });
      assert.deepEqual(decideExposure(admin, req("/contacts", "PANEL.example.test", "10.77.0.200")), { allow: true });
      assert.deepEqual(decideExposure(admin, req("/api/cron/outbox", "panel.example.test", "127.0.0.1")), { allow: true });
    });
    it("outside the VPN even the login page and the health check are a 404", () => {
      for (const path of ["/login", "/login/mfa", "/", "/contacts", "/api/export", "/api/media/1", "/api/cron/outbox", "/api/health"]) {
        for (const ip of ["203.0.113.9", "10.78.0.5", "192.168.1.5", "", null]) {
          assert.deepEqual(decideExposure(admin, req(path, "panel.example.test", ip)), { allow: false, status: 404, reason: "network" }, `${path} from ${ip}`);
        }
      }
    });
    it("a wrong or missing Host is refused before anything else (Host-header attacks)", () => {
      for (const host of ["evil.example", "api.example.test", "panel.example.test.evil.example", "", null, "panel.example.test:8443"]) {
        assert.deepEqual(decideExposure(admin, req("/login", host, "10.77.0.5")), { allow: false, status: 421, reason: "host" }, JSON.stringify(host));
      }
      assert.equal(decideExposure(admin, req("/login", "panel.example.test.", "10.77.0.5")).allow, true, "a trailing dot is the same name");
    });
    it("has no public intake and no public reads, even from the VPN", () => {
      for (const path of ["/api/intake/lead", "/api/intake/consent", "/api/public/news", "/api/public/legal", "/api/public/availability"]) {
        assert.deepEqual(decideExposure(admin, req(path, "panel.example.test", "10.77.0.5")), { allow: false, status: 404, reason: "role" }, path);
      }
    });
    it("an IP header that is not in the VPN cannot be fixed by a spoofed second value (only a clean single address matches)", () => {
      assert.equal(decideExposure(admin, req("/login", "panel.example.test", "203.0.113.9, 10.77.0.5")).allow, false);
      assert.equal(decideExposure(admin, req("/login", "panel.example.test", "10.77.0.5, 203.0.113.9")).allow, false);
    });
  });

  describe("the public API deployment", () => {
    it("serves health, intake and public reads", () => {
      for (const path of ["/api/health", "/api/intake/lead", "/api/intake/consent", "/api/public/news", "/api/public/news/some-slug", "/api/public/availability", "/api/public/legal"]) {
        assert.deepEqual(decideExposure(api, req(path, "api.example.test", "203.0.113.9")), { allow: true }, path);
      }
    });
    it("has no login, no staff pages, no admin API, no cron", () => {
      for (const path of ["/", "/login", "/login/mfa", "/contacts", "/contacts/1", "/requests", "/bookings", "/news", "/users", "/audit", "/export", "/retention", "/api/export", "/api/media", "/api/media/1", "/api/cron/outbox", "/account", "/legal"]) {
        assert.deepEqual(decideExposure(api, req(path, "api.example.test", "203.0.113.9")), { allow: false, status: 404, reason: "role" }, path);
      }
    });
    it("is not reachable under the admin host name", () => {
      assert.deepEqual(decideExposure(api, req("/api/health", "panel.example.test", "203.0.113.9")), { allow: false, status: 421, reason: "host" });
    });
  });

  describe("the shared development / Preview deployment", () => {
    it("shows everything as before when nothing is configured", () => {
      const all = exposureFromEnv({});
      assert.deepEqual(all, { role: "all", allowedHosts: [], adminCidrs: [] });
      for (const path of ["/login", "/contacts", "/api/intake/lead", "/api/public/news", "/api/health"]) assert.equal(decideExposure(all, req(path, "anything", null)).allow, true, path);
    });
    it("an unknown role value means 'all', so only the two named roles restrict; typos are caught by the production profile", () => {
      assert.equal(parseRole("Admin"), "all");
      assert.equal(parseRole("admin"), "admin");
      assert.equal(parseRole("api"), "api");
      assert.ok(profileProblems({ PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "Admin" }).includes("role_must_be_admin_or_api"));
    });
  });

  describe("the Kazakhstan production profile (fail closed)", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const goodAdmin = {
      PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "admin", PLATFORM_HTTPS: "1", ALLOWED_HOSTS: "panel.example.test", DATABASE_URL: "postgres://bb_admin@127.0.0.1/db",
      MFA_MODE: "required", MFA_ENC_KEY: key, ADMIN_ALLOWED_CIDRS: "10.77.0.0/24,127.0.0.1/32", CRON_SECRET: "c".repeat(32), REVALIDATE_TOKEN: "r".repeat(32), TELEGRAM_BOT_TOKEN: "x:y", TELEGRAM_CHAT_ID: "1", TELEGRAM_NOTIFY_LEVEL: "minimal", SITE_REVALIDATE_URL: "https://site.example.test",
    };
    const goodApi = { PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "api", PLATFORM_HTTPS: "1", ALLOWED_HOSTS: "api.example.test", DATABASE_URL: "postgres://bb_api@127.0.0.1/db", PLATFORM_INTAKE_TOKEN: "t".repeat(32), PLATFORM_IP_PEPPER: "p".repeat(24) };

    it("a complete admin and a complete API configuration are accepted", () => {
      assert.deepEqual(profileProblems(goodAdmin), []);
      assert.deepEqual(profileProblems(goodApi), []);
      assert.deepEqual(profileProblems({ PLATFORM_ROLE: "all" }), [], "other profiles have no requirements");
    });
    it("the admin is refused without the second factor, without a valid key, without a network allowlist, over plain HTTP, without a host list", () => {
      assert.deepEqual(profileProblems({ ...goodAdmin, MFA_MODE: "off" }), ["mfa_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, MFA_MODE: undefined }), ["mfa_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, MFA_ENC_KEY: "short" }), ["mfa_key_invalid"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, ADMIN_ALLOWED_CIDRS: "" }), ["admin_cidrs_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, PLATFORM_HTTPS: "0" }), ["https_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, ALLOWED_HOSTS: "" }), ["allowed_hosts_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, DATABASE_URL: "" }), ["database_url_required"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, CRON_SECRET: "" }), ["cron_secret_required"]);
    });
    it("notifications in production must be 'minimal': 'full', a typo or nothing at all stops the admin from starting", () => {
      for (const bad of ["full", "FULL", "Minimal", "min", "", undefined]) assert.deepEqual(profileProblems({ ...goodAdmin, TELEGRAM_NOTIFY_LEVEL: bad }), ["notify_level_must_be_minimal"], JSON.stringify(bad));
      assert.deepEqual(profileProblems({ ...goodAdmin, TELEGRAM_NOTIFY_LEVEL: "minimal" }), []);
    });
    it("an allowlist that is really 'everyone' is refused", () => {
      for (const wide of ["0.0.0.0/0", "::/0", "10.0.0.0/7", "10.77.0.0/24,0.0.0.0/0"]) assert.ok(profileProblems({ ...goodAdmin, ADMIN_ALLOWED_CIDRS: wide }).includes("admin_cidrs_too_wide"), wide);
      assert.ok(profileProblems({ ...goodAdmin, ADMIN_ALLOWED_CIDRS: "10.77.0.0/99" }).includes("admin_cidrs_invalid"));
    });
    it("secrets are separated: the admin has no intake token or IP pepper; the API has no MFA key, cron secret, Telegram or revalidate secret", () => {
      assert.deepEqual(profileProblems({ ...goodAdmin, PLATFORM_INTAKE_TOKEN: "t".repeat(32) }), ["admin_must_not_have_platform_intake_token"]);
      assert.deepEqual(profileProblems({ ...goodAdmin, PLATFORM_IP_PEPPER: "p" }), ["admin_must_not_have_platform_ip_pepper"]);
      for (const [k, name] of [["MFA_ENC_KEY", "mfa_enc_key"], ["CRON_SECRET", "cron_secret"], ["TELEGRAM_BOT_TOKEN", "telegram_bot_token"], ["TELEGRAM_CHAT_ID", "telegram_chat_id"], ["TELEGRAM_NOTIFY_LEVEL", "telegram_notify_level"], ["REVALIDATE_TOKEN", "revalidate_token"], ["SITE_REVALIDATE_URL", "site_revalidate_url"]] as const) {
        assert.deepEqual(profileProblems({ ...goodApi, [k]: "x".repeat(40) }), [`api_must_not_have_${name}`], k);
      }
      assert.deepEqual(profileProblems({ ...goodApi, ADMIN_ALLOWED_CIDRS: "10.77.0.0/24" }), ["api_must_not_have_admin_cidrs"]);
      assert.deepEqual(profileProblems({ ...goodApi, PLATFORM_INTAKE_TOKEN: "short" }), ["intake_token_required"]);
    });
    it("problems are codes only: no secret value ever appears in them", () => {
      const text = JSON.stringify(profileProblems({ ...goodApi, MFA_ENC_KEY: "SUPERSECRETVALUE", CRON_SECRET: "ANOTHERSECRETVALUE" }));
      assert.ok(!text.includes("SECRETVALUE"));
    });
  });
});

describe("Exposure: the proxy cannot be skipped by a header the client chooses", () => {
  it("the matcher is unconditional: no `missing`, no `has`, no header names, no path exclusions", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
    const cfg = /export const config = (\{[^}]*\});/.exec(src)?.[1] ?? "";
    assert.equal(cfg.replace(/\s+/g, " "), '{ matcher: "/:path*" }');
    assert.ok(!/missing\s*:|has\s*:/.test(cfg));
    // the only place a header may influence the flow is the exposure decision (Host / forwarded host / real address): it can only DENY
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/next-router-prefetch|x-middleware-prefetch|x-middleware-subrequest|x-nextjs-data|purpose/i.test(code), "no branch on a client-controlled framework header");
  });

  it("static assets are classified like admin pages, so role, host and network rules apply to them too", () => {
    for (const p of ["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico"]) {
      assert.equal(classifyPath(p), "admin", p);
      assert.deepEqual(decideExposure(admin, { pathname: p, host: "panel.example.test", realIp: "203.0.113.9" }), { allow: false, status: 404, reason: "network" }, p);
      assert.deepEqual(decideExposure(api, { pathname: p, host: "api.example.test", realIp: "203.0.113.9" }), { allow: false, status: 404, reason: "role" }, p);
      assert.deepEqual(decideExposure(admin, { pathname: p, host: "evil.example", realIp: "10.77.0.5" }), { allow: false, status: 421, reason: "host" }, p);
      assert.deepEqual(decideExposure(admin, { pathname: p, host: "panel.example.test", realIp: "10.77.0.5" }), { allow: true }, p);
    }
  });

  it("the decision looks only at Host, the forwarded host and the real address: a request with any other header decides the same", () => {
    const forged = ["next-router-prefetch", "x-middleware-prefetch", "purpose", "rsc", "next-url", "x-nextjs-data", "x-middleware-subrequest"];
    // decideExposure has no header input at all besides those three values; this documents and pins the signature
    assert.equal(decideExposure.length, 2);
    for (let i = 0; i < forged.length; i++) assert.deepEqual(decideExposure(admin, req("/login", "panel.example.test", "203.0.113.9")), { allow: false, status: 404, reason: "network" });
  });
});

describe("internal parent-session API: served by the api role only", () => {
  const api = { role: "api" as const, allowedHosts: ["api.example.test"], adminCidrs: ["10.77.0.0/24"] };
  const admin = { role: "admin" as const, allowedHosts: ["panel.example.test"], adminCidrs: ["10.77.0.0/24"] };
  const req = (pathname: string, host: string) => ({ pathname, host, realIp: "127.0.0.1" });

  it("is classified as internal; lookalikes stay admin", () => {
    assert.equal(classifyPath("/api/internal/parent-sessions/lookup"), "internal");
    for (const p of ["/api/internal/parent-sessions", "/api/internal/parent-sessionsx/lookup", "/api/internal/other"]) assert.equal(classifyPath(p), "admin", p);
  });

  it("answers on the api process, to the site on loopback", () => {
    assert.deepEqual(decideExposure(api, req("/api/internal/parent-sessions/lookup", "api.example.test")), { allow: true });
  });

  it("is a 404 on the admin process, even from the VPN", () => {
    assert.deepEqual(decideExposure(admin, { ...req("/api/internal/parent-sessions/lookup", "panel.example.test"), realIp: "10.77.0.5" }), {
      allow: false,
      status: 404,
      reason: "role",
    });
  });
});
