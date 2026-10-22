// Isolation of the admin: real processes, real roles, real browser.
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/boombala_platform npm run e2e:isolation
// Needs: platform built (`npm run build`), the site built (`npm run build` in the repo root) and a LOCAL database with
// migrations applied. It starts, on loopback ports, a public-API process (role api, database role bb_api), a staff process
// (role admin, MFA required, VPN source allowlist, database role bb_admin), a production-profile process and a
// misconfigured one, plus the public site. "The VPN" is simulated by the X-Real-IP header, which in production only
// nginx writes (the app listens on loopback); the real WireGuard / nginx / firewall layer is checked by deploy/kz/verify-isolation.sh.
// Everything is synthetic and local.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { chromium } from "playwright-core";
import { applyRoles } from "../scripts/db-roles.ts";
import { createUser } from "../src/core/users.ts";
import { beginEnrollment, confirmEnrollment } from "../src/core/mfa.ts";
import { createPool } from "../src/core/db.ts";
import { totpAt } from "../src/core/totp.ts";
import { createSession, revokeSessionsWithoutMfa } from "../src/core/session.ts";

const DB = process.env.DATABASE_URL;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
const OUT = process.env.E2E_SCREENSHOTS ?? "";
if (OUT) mkdirSync(OUT, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const repo = new URL("../..", import.meta.url).pathname;
const run = String(Date.now()).slice(-6);
const rnd = (n = 24) => randomBytes(n).toString("base64url");

const API = { port: 3201, host: "127.0.0.1:3201" };
const ADMIN = { port: 3202, host: "127.0.0.1:3202" };
const PROD = { port: 3203, host: "panel.example.test" };
const BAD = { port: 3204, host: "127.0.0.1:3204" };
const SITE = { port: 3205, host: "127.0.0.1:3205" };
const VPN_IP = "10.77.0.5";
const OUTSIDE_IP = "203.0.113.9";
const MFA_KEY = randomBytes(32).toString("base64");
const INTAKE = rnd(32);
const PW = "correct horse battery staple " + run;
const ROLE_API_PW = rnd(24) + "A1";
const ROLE_ADMIN_PW = rnd(24) + "B2";

let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);

// ── plumbing ──────────────────────────────────────────────────────────────────────────────────────────────────
const children = [];
const logs = new Map();
function start(label, cwd, port, env) {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd, env: { ...process.env, NODE_ENV: "production", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const buf = [];
  logs.set(label, buf);
  child.stdout.on("data", (d) => buf.push(String(d)));
  child.stderr.on("data", (d) => buf.push(String(d)));
  children.push(child);
  return child;
}
const stopAll = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("exit", stopAll);

function raw(port, path, { method = "GET", host, ip, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host) h.host = host;
    if (ip) h["x-real-ip"] = ip;
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
async function waitFor(port) {
  for (let i = 0; i < 120; i++) {
    const up = await new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => (s.destroy(), r(true)));
      s.on("error", () => r(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`port ${port} did not open`);
}

// ── database: roles for the two applications, users for the three staff roles ─────────────────────────────────
const owner = createPool(DB, { max: 3 });
await applyRoles(owner, { apiPassword: ROLE_API_PW, adminPassword: ROLE_ADMIN_PW });
const asRole = (user, pass) => {
  const u = new URL(DB);
  u.username = user;
  u.password = pass;
  return u.toString();
};
const staff = {};
for (const role of ["owner", "manager", "editor"]) {
  staff[role] = await createUser(owner, null, { email: `iso.${role}.${run}@example.test`, name: `Iso ${role}`, role, password: PW });
}
/** Enrol manager and editor directly (the Owner does it through the browser below). */
const secrets = {};
for (const role of ["manager", "editor"]) {
  const e = await beginEnrollment(owner, staff[role].id, MFA_KEY);
  const done = await confirmEnrollment(owner, staff[role].id, totpAt(e.secret, Date.now()), MFA_KEY);
  secrets[role] = { secret: e.secret, codes: done.recoveryCodes };
}

// ── processes ─────────────────────────────────────────────────────────────────────────────────────────────────
const adminEnv = {
  PLATFORM_ROLE: "admin", ALLOWED_HOSTS: ADMIN.host, DATABASE_URL: asRole("bb_admin", ROLE_ADMIN_PW), MFA_MODE: "required", MFA_ENC_KEY: MFA_KEY,
  ADMIN_ALLOWED_CIDRS: "10.77.0.0/24,127.0.0.1/32", CRON_SECRET: rnd(32), REVALIDATE_TOKEN: rnd(32),
};
const baseClean = { PLATFORM_INTAKE_TOKEN: "", PLATFORM_IP_PEPPER: "", MFA_ENC_KEY: "", MFA_MODE: "", CRON_SECRET: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", SITE_REVALIDATE_URL: "", REVALIDATE_TOKEN: "", PII_INTAKE_ENABLED: "", PLATFORM_HTTPS: "", PLATFORM_PROFILE: "", ADMIN_ALLOWED_CIDRS: "", ALLOWED_HOSTS: "", PLATFORM_ROLE: "" };

start("api", root, API.port, { ...baseClean, PLATFORM_ROLE: "api", ALLOWED_HOSTS: API.host, DATABASE_URL: asRole("bb_api", ROLE_API_PW), PLATFORM_INTAKE_TOKEN: INTAKE, PLATFORM_IP_PEPPER: rnd(24) });
start("admin", root, ADMIN.port, { ...baseClean, ...adminEnv });
start("prod", root, PROD.port, {
  ...baseClean, ...adminEnv, PLATFORM_PROFILE: "kz-production", PLATFORM_HTTPS: "1", ALLOWED_HOSTS: PROD.host,
});
start("bad", root, BAD.port, { ...baseClean, PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "admin", ALLOWED_HOSTS: BAD.host, DATABASE_URL: asRole("bb_admin", ROLE_ADMIN_PW), PLATFORM_HTTPS: "1", MFA_MODE: "off" });
start("site", repo, SITE.port, { ...baseClean });
await Promise.all([API, ADMIN, PROD, BAD, SITE].map((p) => waitFor(p.port)));

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });

try {
  // ══ 1. The public API process ═══════════════════════════════════════════════════════════════════════════════
  console.log("## 1. public API process: only what a client needs");
  {
    const get = (path, extra = {}) => raw(API.port, path, { host: API.host, ip: OUTSIDE_IP, ...extra });
    ok((await get("/api/health")).status === 200, "health check answers");
    for (const p of ["/login", "/login/mfa", "/", "/contacts", "/requests", "/bookings", "/users", "/audit", "/export", "/retention", "/news", "/account", "/legal", "/api/export", "/api/media/1", "/api/cron/outbox"]) {
      const r = await get(p);
      ok(r.status === 404 && r.body === "" && !r.headers["set-cookie"] && !r.headers.location, `${p} does not exist on the public API (404, empty, no redirect to a login page)`);
    }
    const noToken = await get("/api/intake/lead", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(noToken.status === 401, "intake without the secret is refused");
    const off = await get("/api/intake/lead", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INTAKE}` }, body: "{}" });
    ok(off.status === 503 && off.body.includes("intake_disabled"), "with the secret, intake is still OFF: no personal data is accepted while the flag is off");
    ok((await get("/api/public/legal")).status === 401, "public reads need the secret too");
    ok((await get("/api/health", { host: "evil.example" })).status === 421, "a wrong Host name is refused");
    ok((await get("/api/health", { headers: { "x-forwarded-host": "evil.example" } })).status === 421, "a spoofed forwarded host is refused");
    const home = await get("/api/health");
    ok(!home.headers["set-cookie"], "the public API never sets a cookie");
  }

  // ══ 2. The staff process: network and host ══════════════════════════════════════════════════════════════════
  console.log("## 2. staff process: invisible outside the VPN");
  {
    const a = (path, o = {}) => raw(ADMIN.port, path, { host: ADMIN.host, ...o });
    for (const p of ["/login", "/login/mfa", "/", "/contacts", "/api/health", "/api/export", "/api/media/1", "/api/cron/outbox", "/anything"]) {
      for (const ip of [OUTSIDE_IP, "10.78.0.5", undefined]) {
        const r = await a(p, { ip });
        ok(r.status === 404 && r.body === "" && !r.headers["set-cookie"] && !r.headers.location, `${p} from ${ip ?? "no address"}: 404, empty, no redirect`);
      }
    }
    const login = await a("/login", { ip: VPN_IP });
    ok(login.status === 200 && login.body.includes("Вход для сотрудников"), "from the VPN the login page is served");
    ok((await a("/api/health", { ip: VPN_IP })).status === 200, "from the VPN the health check answers");
    ok((await a("/api/intake/lead", { ip: VPN_IP, method: "POST" })).status === 404, "the staff process has no public intake, even from the VPN");
    ok((await a("/api/public/news", { ip: VPN_IP })).status === 404, "the staff process has no public reads either");
    ok((await a("/login", { ip: VPN_IP, host: "evil.example" })).status === 421, "wrong Host, even from the VPN");
    ok((await a("/login", { ip: VPN_IP, headers: { "x-forwarded-host": "evil.example" } })).status === 421, "Host-header injection through X-Forwarded-Host is refused");
    ok((await a("/login", { ip: `${OUTSIDE_IP}, ${VPN_IP}` })).status === 404, "a forged list of addresses does not pass");
    ok((await a("/api/cron/outbox", { ip: "127.0.0.1" })).status === 401, "the local timer reaches the worker endpoint, which still wants its secret");
    ok(login.headers["x-frame-options"] === "DENY" && /frame-ancestors 'none'/.test(login.headers["content-security-policy"] ?? ""), "security headers are present");
  }

  // ══ 3. Production profile ═══════════════════════════════════════════════════════════════════════════════════
  console.log("## 3. production profile: complete configuration serves, a wrong one serves nothing");
  {
    const p = (path, o = {}) => raw(PROD.port, path, { host: PROD.host, ...o });
    const good = await p("/login", { ip: VPN_IP });
    ok(good.status === 200, "a complete kz-production configuration serves the login page to the VPN");
    ok(/max-age=31536000/.test(good.headers["strict-transport-security"] ?? ""), "HSTS is on");
    ok((await p("/login", { ip: OUTSIDE_IP })).status === 404, "and still nothing outside the VPN");
    for (const path of ["/login", "/api/health", "/"]) {
      const r = await raw(BAD.port, path, { host: BAD.host, ip: VPN_IP });
      ok(r.status === 503 && !r.headers["set-cookie"], `misconfigured production (no second factor, no network allowlist): ${path} is 503`);
    }
    const reasons = (logs.get("bad") ?? []).join("");
    ok(/profile\.invalid/.test(reasons) && /mfa_required/.test(reasons) && /admin_cidrs_required/.test(reasons), "the reasons are logged as codes");
    ok(!reasons.includes(ROLE_ADMIN_PW) && !reasons.includes(MFA_KEY), "no secret appears in those logs");
  }

  // ══ 3b. Forged request headers must not change any decision ═══════════════════════════════════════════════
  console.log("## 3b. forged framework and proxy headers cannot skip the checks");
  {
    const FORGED = [
      { "next-router-prefetch": "1" }, { "next-router-prefetch": "true" }, { "x-middleware-prefetch": "1" }, { purpose: "prefetch" }, { rsc: "1" },
      { "next-router-state-tree": "%5B%22%22%5D" }, { "next-url": "/login" }, { "x-nextjs-data": "1" },
      { "x-middleware-subrequest": "middleware" }, { "x-middleware-subrequest": "proxy" }, { "x-middleware-subrequest": "src/middleware" }, { "x-middleware-subrequest": "src/proxy" },
      { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" }, { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" },
      { "x-forwarded-for": VPN_IP }, { "x-vercel-forwarded-for": VPN_IP }, { forwarded: `for=${VPN_IP}` }, { "x-original-url": "/login" }, { "x-rewrite-url": "/login" },
      { "next-router-prefetch": "1", "x-middleware-prefetch": "1", purpose: "prefetch", rsc: "1" },
    ];
    // a real build asset, taken from the login page the VPN sees
    const loginPage = await raw(ADMIN.port, "/login", { host: ADMIN.host, ip: VPN_IP });
    const asset = /\/_next\/static\/[^"' ]+\.js/.exec(loginPage.body)?.[0];
    ok(!!asset, `found a real build asset (${asset})`);
    ok((await raw(ADMIN.port, asset, { host: ADMIN.host, ip: VPN_IP })).status === 200, "from the VPN the asset is served");
    const wrongNet = [{ ip: OUTSIDE_IP }, { ip: undefined }, { ip: "10.78.0.5" }];
    let bypass = 0, checks = 0;
    const same = (r, status) => (checks++, r.status === status && r.body === "" && !r.headers["set-cookie"] && !r.headers.location ? 0 : 1);
    for (const h of FORGED) {
      for (const net of wrongNet) {
        for (const p of ["/login", "/contacts", "/", "/api/health", "/api/export", "/api/cron/outbox", "/login/mfa", asset]) {
          bypass += same(await raw(ADMIN.port, p, { host: ADMIN.host, ip: net.ip, headers: h }), 404);
        }
      }
      bypass += same(await raw(ADMIN.port, "/login", { host: "evil.example", ip: VPN_IP, headers: h }), 421);
      bypass += same(await raw(ADMIN.port, asset, { host: "evil.example", ip: VPN_IP, headers: h }), 421);
      for (const p of ["/login", "/login/mfa", "/contacts", "/api/export", "/api/cron/outbox", asset]) {
        bypass += same(await raw(API.port, p, { host: API.host, ip: OUTSIDE_IP, headers: h }), 404);
      }
      bypass += same(await raw(API.port, "/api/health", { host: "evil.example", ip: OUTSIDE_IP, headers: h }), 421);
      for (const p of ["/login", "/api/health", "/"]) {
        const r = await raw(BAD.port, p, { host: BAD.host, ip: VPN_IP, headers: h });
        checks++;
        if (r.status !== 503 || r.headers["set-cookie"]) bypass++;
      }
      bypass += same(await raw(PROD.port, "/login", { host: PROD.host, ip: OUTSIDE_IP, headers: h }), 404);
      bypass += same(await raw(PROD.port, "/login", { host: "evil.example", ip: VPN_IP, headers: h }), 421);
    }
    ok(bypass === 0, `${checks} forged-header requests: none got past role, Host, VPN network or the fail-closed profile (${bypass} bypasses)`);
    // the forged headers also do not widen a legitimate request into something else
    const asVpn = await raw(ADMIN.port, "/contacts", { host: ADMIN.host, ip: VPN_IP, headers: { "next-router-prefetch": "1" } });
    ok(asVpn.status === 307 || asVpn.status === 303 || asVpn.status === 302, "inside the VPN a prefetch header does not turn a missing login into access (redirected to the login)");
    ok((await raw(API.port, asset, { host: API.host, ip: OUTSIDE_IP })).status === 404, "the public API does not serve the admin's build assets");
  }

  // ══ 4. The public site ══════════════════════════════════════════════════════════════════════════════════════
  console.log("## 4. public site: no staff routes, no staff cookies");
  {
    for (const p of ["/login", "/admin", "/admin/login", "/contacts", "/requests", "/bookings", "/export", "/users", "/audit", "/retention", "/api/export", "/api/media/1", "/api/cron/outbox", "/api/intake/lead", "/api/public/legal", "/login/mfa", "/_admin"]) {
      const r = await raw(SITE.port, p, { host: SITE.host });
      ok(r.status === 404, `site ${p} is 404 (status ${r.status})`);
    }
    const home = await raw(SITE.port, "/", { host: SITE.host });
    ok(home.status === 200, "the site home page is served");
    ok(!/bb_session|__Host-bb_session/.test(JSON.stringify(home.headers)), "the site sets no staff session cookie");
  }

  // ══ 5. Staff browser: second factor, cookies, roles, inside the VPN ═════════════════════════════════════════
  console.log("## 5. staff browser flow inside the VPN (second factor mandatory)");
  const A = `http://${ADMIN.host}`;
  const vpnCtx = async () => browser.newContext({ extraHTTPHeaders: { "x-real-ip": VPN_IP }, viewport: { width: 1100, height: 800 } });
  const login = async (page, email) => {
    await page.goto(A + "/login", { waitUntil: "networkidle" });
    await page.locator("input[name=email]").fill(email);
    await page.locator("input[name=password]").fill(PW);
    await page.getByRole("button", { name: "Войти" }).click();
  };
  const finish = async (page, code, label = "Войти") => {
    await page.locator("input[name=code]").fill(code);
    await page.getByRole("button", { name: label }).click();
  };
  const bodyText = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  let ownerSecret = "";
  let enrolCode = "";
  let ownerCodes = [];
  {
    const ctx = await vpnCtx();
    const page = await ctx.newPage();
    const setCookies = [];
    page.on("response", async (r) => {
      const h = await r.allHeaders().catch(() => ({}));
      if (h["set-cookie"]) setCookies.push(h["set-cookie"]);
    });
    await login(page, staff.owner.email);
    await page.waitForURL(/\/login\/mfa/);
    ok(true, "a correct password leads to the second-factor page, not to the admin");
    const pending = (await ctx.cookies()).find((c) => c.name === "bb_session");
    ok(!!pending, "a pending session cookie exists");
    for (const p of ["/", "/contacts", "/requests", "/bookings", "/users", "/news", "/export", "/retention", "/audit"]) {
      await page.goto(A + p);
      const t = await bodyText(page);
      ok(/\/login/.test(new URL(page.url()).pathname) && !/Клиенты|Заявки|Сотрудники|Журнал|Выгрузка|Здравствуйте/.test(t.replace("Подтверждение входа", "")), `${p} with only a password is not the admin (${new URL(page.url()).pathname})`);
    }
    await page.goto(A + "/login/mfa");
    ownerSecret = (await page.locator("[data-testid=mfa-secret]").innerText()).trim();
    ok(/^[A-Z2-7]{32}$/.test(ownerSecret), "the enrolment page shows a base32 secret");
    ok((await page.locator("a[href^='otpauth://']").count()) === 1, "and an authenticator link");
    await finish(page, "000000", "Включить и войти");
    await page.getByText("Неверный код.").waitFor();
    ok(true, "a wrong code is refused");
    enrolCode = totpAt(ownerSecret, Date.now());
    await finish(page, enrolCode, "Включить и войти");
    await page.locator("[data-testid=recovery-codes]").waitFor();
    ownerCodes = (await page.locator("[data-testid=recovery-codes] li").allInnerTexts()).map((s) => s.trim());
    ok(ownerCodes.length === 10 && ownerCodes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)), "ten recovery codes are shown once");
    const verified = (await ctx.cookies()).find((c) => c.name === "bb_session");
    ok(verified && verified.value !== pending.value, "the session token changed after the second factor");
    ok(verified.httpOnly && verified.sameSite === "Lax" && verified.path === "/", "the cookie is HttpOnly, SameSite=Lax, Path=/");
    ok(setCookies.length >= 2 && setCookies.every((c) => !/domain=/i.test(c) && /httponly/i.test(c)), "no Domain attribute: the cookie belongs to this host only, never to a parent domain");
    ok((await page.evaluate(() => document.cookie)) === "", "the cookie is not readable by scripts");
    await page.getByRole("link", { name: "Я сохранил коды, продолжить" }).click();
    await page.waitForURL(A + "/");
    ok((await bodyText(page)).includes("Здравствуйте"), "after the second factor the dashboard opens");
    ok((await page.locator("header, nav").first().innerText()).includes("Сотрудники"), "the Owner sees every section");

    // the Owner's pages and permissions
    for (const [p, h] of [["/users", "Сотрудники"], ["/retention", "Хранение данных"], ["/audit", "Журнал"], ["/contacts", "Клиенты"], ["/news", "Новости"]]) {
      await page.goto(A + p);
      ok((await page.locator("h1").first().innerText()).includes(h), `Owner: ${p} opens`);
    }

    // same-origin and foreign-origin export (CSRF / Origin)
    const form = () => {
      const f = new FormData();
      f.append("format", "csv");
      f.append("columns", "name");
      return f;
    };
    const own = await ctx.request.post(A + "/api/export", { headers: { origin: A }, multipart: form() });
    ok(own.status() === 200, "Owner export from the admin's own origin works");
    const evil = await ctx.request.post(A + "/api/export", { headers: { origin: "https://evil.example" }, multipart: form() });
    ok(evil.status() === 403 || evil.status() === 421 || evil.status() === 400, `an export request from a foreign origin is refused (${evil.status()})`);

    // the Owner resets the Manager's second factor in the interface
    await page.goto(A + "/users");
    const mgrCtx = await vpnCtx();
    const mgr = await mgrCtx.newPage();
    await login(mgr, staff.manager.email);
    await mgr.waitForURL(/\/login\/mfa/);
    ok((await mgr.locator("[data-testid=mfa-secret]").count()) === 0, "an enrolled Manager is asked for a code, not shown a secret");
    await finish(mgr, totpAt(secrets.manager.secret, Date.now() + 30_000));
    await mgr.waitForURL(A + "/");
    for (const [p, allowed] of [["/contacts", true], ["/requests", true], ["/bookings", true], ["/news", false], ["/users", false], ["/retention", false], ["/audit", false], ["/export", false], ["/legal", false]]) {
      await mgr.goto(A + p);
      const here = new URL(mgr.url()).pathname;
      ok(allowed ? here === p : here === "/", `Manager inside the VPN: ${p} ${allowed ? "opens" : "is refused"}`);
    }
    await mgr.goto(A + "/contacts");
    const contactsMgr = await bodyText(mgr);
    ok(!/Отозвать согласие|Обезличить/.test(contactsMgr), "Manager has no withdrawal or anonymisation controls");

    await page.goto(A + "/users");
    const card = page.locator("article", { hasText: staff.manager.email });
    await card.getByRole("button", { name: "Сбросить второй фактор" }).click();
    await page.waitForURL(/notice=mfa/);
    ok(true, "the Owner resets the Manager's second factor");
    await mgr.goto(A + "/contacts");
    ok(new URL(mgr.url()).pathname.startsWith("/login"), "the Manager's open session ended at once");
    await mgrCtx.close();

    // the Editor
    const edCtx = await vpnCtx();
    const ed = await edCtx.newPage();
    await login(ed, staff.editor.email);
    await ed.waitForURL(/\/login\/mfa/);
    await finish(ed, totpAt(secrets.editor.secret, Date.now() + 30_000));
    await ed.waitForURL(A + "/");
    for (const [p, allowed] of [["/news", true], ["/contacts", false], ["/requests", false], ["/bookings", false], ["/users", false], ["/export", false], ["/retention", false]]) {
      await ed.goto(A + p);
      const here = new URL(ed.url()).pathname;
      ok(allowed ? here === p : here === "/", `Editor inside the VPN: ${p} ${allowed ? "opens" : "is refused"}`);
    }
    await edCtx.close();

    // logout, then the Owner returns with a recovery code; a used code and a replayed TOTP code are refused
    await page.getByRole("button", { name: "Выйти" }).click();
    await page.waitForURL(/\/login/);
    const after = await ctx.cookies();
    ok(!after.some((c) => c.name === "bb_session" && c.value === verified.value), "logout removes the cookie");
    const old = await (await ctx.request.get(A + "/contacts", { maxRedirects: 0 })).status();
    ok(old === 307 || old === 303 || old === 302, "and the old session is dead");
    await login(page, staff.owner.email);
    await page.waitForURL(/\/login\/mfa/);
    ok((await page.locator("[data-testid=mfa-secret]").count()) === 0, "second visit asks for a code only");
    await finish(page, enrolCode); // the very code that enrolled the device: its time step is spent
    await page.getByText("Неверный код.").waitFor();
    ok(true, "the code that enrolled the device cannot be replayed");
    await finish(page, ownerCodes[0]);
    await page.waitForURL(A + "/");
    ok(true, "a recovery code opens the session");
    await page.getByRole("button", { name: "Выйти" }).click();
    await login(page, staff.owner.email);
    await page.waitForURL(/\/login\/mfa/);
    await finish(page, ownerCodes[0]);
    await page.getByText("Неверный код.").waitFor();
    ok(true, "a used recovery code is dead");
    await ctx.close();
  }

  // ══ 5b. A session issued before the second factor became mandatory ═══════════════════════════════════════════
  console.log("## 5b. an old session (password only, issued earlier) is useless once the second factor is mandatory");
  {
    // the Editor IS enrolled; this session was issued the old way, without the factor
    const legacy = await createSession(owner, staff.editor.id, { ip: VPN_IP });
    const ctx = await vpnCtx();
    await ctx.addCookies([{ name: "bb_session", value: legacy.token, url: A }]);
    const page = await ctx.newPage();
    for (const p of ["/news", "/", "/account"]) {
      await page.goto(A + p);
      const t = await bodyText(page);
      ok(new URL(page.url()).pathname === "/login" && !/Здравствуйте|Новости и акции|Мой пароль/.test(t), `an old session for an enrolled user does not open ${p} (sent to the login)`);
    }
    const viaApi = await ctx.request.get(A + "/api/media/00000000-0000-0000-0000-000000000000", { maxRedirects: 0 });
    ok(viaApi.status() !== 200, "nor the admin API");
    const ended = await revokeSessionsWithoutMfa(owner);
    ok(ended >= 1, `the forced revocation ends such sessions for good (${ended})`);
    ok(Number((await owner.query("SELECT count(*)::int n FROM bb.sessions WHERE token_hash = $1 AND revoked_at IS NOT NULL", [(await import("node:crypto")).createHash("sha256").update(legacy.token).digest()])).rows[0].n) === 1, "the old session is marked ended");
    await ctx.close();
  }

  // ══ 6. Outside the VPN, with a valid password ═══════════════════════════════════════════════════════════════
  console.log("## 6. a stranger outside the VPN, even with valid credentials");
  {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": OUTSIDE_IP } });
    const page = await ctx.newPage();
    const r = await ctx.request.get(A + "/login", { maxRedirects: 0 });
    ok(r.status() === 404 && (await r.text()) === "", "the login page is an empty 404 outside the VPN");
    await page.goto(A + "/login").catch(() => {}); // an empty 404 is shown by the browser as its own error page
    ok((await page.locator("input").count()) === 0, "no form, nothing to guess");
    const post = await ctx.request.post(A + "/login", { form: { email: staff.owner.email, password: PW }, maxRedirects: 0 });
    ok(post.status() === 404, "a login attempt with valid credentials gets 404 too");
    ok((await ctx.cookies()).length === 0, "no cookie is ever issued");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopAll();
  await owner.end();
}

if (fails) {
  console.log(`\nFAILS: ${fails}`);
  for (const [k, v] of logs) if (k === "admin" || k === "api") console.log(`--- ${k} log tail ---\n${v.join("").slice(-1500)}`);
}
console.log(fails ? "" : "\nALL OK");
process.exit(fails ? 1 : 0);
