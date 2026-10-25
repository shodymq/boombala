// Passkeys (Face ID / Touch ID) in a real browser with a virtual authenticator (Chrome DevTools WebAuthn domain), end to end:
// the Owner's one-time enrolment code for a NEW employee, step-up before adding / revoking a key, sign-in without a password, the
// second-factor page, revocation (own, and the Owner's), the fallback (password + code), origin / RP ID rejections, the guards of the endpoints.
// Local database and a local process only; everything is synthetic.
//   DATABASE_URL=postgres://postgres@127.0.0.1:54331/bb_pkdev npm run e2e:passkeys
// Needs: the platform built (`npm run build`) and a migrated LOCAL database. It starts its own staff process on localhost.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { chromium } from "playwright-core";
import { createPool } from "../src/core/db.ts";
import { beginEnrollment, confirmEnrollment } from "../src/core/mfa.ts";
import { totpAt } from "../src/core/totp.ts";
import { createUser } from "../src/core/users.ts";

const DB = process.env.DATABASE_URL;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
const root = new URL("..", import.meta.url).pathname;
const PORT = 3801;
const OFF_PORT = 3802;
const BASE = `http://localhost:${PORT}`;
const MFA_KEY = randomBytes(32).toString("base64");
const PW = "correct horse battery staple " + Date.now().toString(36);
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);

const pool = createPool(DB, { max: 3 });
const stamp = Date.now();
const users = {};
const secrets = {};
for (const role of ["owner", "manager"]) {
  users[role] = await createUser(pool, null, { email: `pk.${role}.${stamp}@example.test`, name: `PK ${role}`, role, password: PW });
  const e = await beginEnrollment(pool, users[role].id, MFA_KEY);
  await confirmEnrollment(pool, users[role].id, totpAt(e.secret, Date.now()), MFA_KEY);
  secrets[role] = e.secret;
}
// a NEW employee: created by the Owner with a password, nothing else
users.newbie = await createUser(pool, null, { email: `pk.newbie.${stamp}@example.test`, name: "PK newbie", role: "manager", password: PW });

/** A current authenticator code; a code works once, so the test clears the "last used step" first. */
async function code(role) {
  await pool.query("UPDATE bb.user_mfa SET last_step = 0 WHERE user_id = $1", [users[role].id]);
  return totpAt(secrets[role], Date.now());
}

const logs = [];
const common = { ...process.env, NODE_ENV: "production", DATABASE_URL: DB, MFA_MODE: "required", MFA_ENC_KEY: MFA_KEY, PLATFORM_PROFILE: "", PLATFORM_ROLE: "", ALLOWED_HOSTS: "", ADMIN_ALLOWED_CIDRS: "", PLATFORM_HTTPS: "" };
function start(port, env) {
  const c = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env: { ...common, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => logs.push(String(d)));
  c.stderr.on("data", (d) => logs.push(String(d)));
  return c;
}
const on = start(PORT, { PASSKEYS_ENABLED: "1", WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: `http://localhost:${PORT}` });
const off = start(OFF_PORT, {});
const stop = () => [on, off].forEach((c) => c.kill("SIGTERM"));
process.on("exit", stop);
for (const port of [PORT, OFF_PORT]) {
  for (let i = 0; i < 120; i++) {
    if (await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => (s.destroy(), r(true))); s.on("error", () => r(false)); })) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function newDevice(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 1000 }, hasTouch: true, isMobile: true, ...opts });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp };
}
async function passwordLogin(page, who) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.locator("input[name=email]").fill(users[who].email);
  await page.locator("input[name=password]").fill(PW);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/);
}
async function totpLogin(page, who) {
  await passwordLogin(page, who);
  await page.locator("input[name=code]").fill(await code(who));
  await page.getByRole("button", { name: "Войти" }).last().click();
  await page.waitForURL((u) => u.pathname === "/");
}
const text = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
/** The step-up panel: confirm with a code from the authenticator app. */
async function stepUpWithCode(page, who) {
  await page.locator('[data-testid="stepup-code"]').fill(await code(who));
  await page.locator('[data-testid="stepup-submit"]').click();
  await page.locator('[data-testid="stepup"]').waitFor({ state: "detached" });
}

try {
  console.log("## 0. passkeys are off unless enabled");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${OFF_PORT}/login`, { waitUntil: "networkidle" });
    ok((await page.locator('[data-testid="passkey-login"]').count()) === 0, "no passkey button when PASSKEYS_ENABLED is not set");
    const r = await fetch(`http://localhost:${OFF_PORT}/api/webauthn/login/options`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${OFF_PORT}` }, body: "{}" });
    ok(r.status === 404, `the endpoints answer 404 (${r.status})`);
    await ctx.close();
  }

  console.log("## 1. a NEW employee: a password alone enrols nothing; the Owner hands over a one-time code");
  const nb = await newDevice();
  await passwordLogin(nb.page, "newbie");
  ok((await nb.page.locator('[data-testid="enroll-code-form"]').count()) === 1 && (await nb.page.locator('[data-testid="mfa-secret"]').count()) === 0, "after the password: «Нужен код настройки», and NO authenticator secret is shown");
  await nb.page.locator("input[name=code]").fill("AAAA-BBBB-CCCC");
  await nb.page.getByRole("button", { name: "Продолжить" }).click();
  await nb.page.getByText(/Код не подошёл/).waitFor();
  ok((await nb.page.locator('[data-testid="mfa-secret"]').count()) === 0, "a wrong code opens nothing");
  const o = await newDevice();
  await totpLogin(o.page, "owner");
  await o.page.goto(BASE + "/users", { waitUntil: "networkidle" });
  const tools = o.page.locator(`[data-testid="owner-tools-${users.newbie.id}"]`);
  await tools.locator('[data-testid="issue-code"]').click();
  await o.page.locator('[data-testid="stepup"]').waitFor();
  ok(!(await tools.locator('[data-testid="enrollment-code"]').count()), "the code is NOT issued before the Owner's step-up");
  await stepUpWithCode(o.page, "owner");
  await tools.locator('[data-testid="enrollment-code-value"]').waitFor();
  const issued = (await tools.locator('[data-testid="enrollment-code-value"]').innerText()).trim();
  ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(issued), "after the step-up the one-time code is shown once");
  await nb.page.locator("input[name=code]").fill(issued);
  await nb.page.getByRole("button", { name: "Продолжить" }).click();
  await nb.page.locator('[data-testid="mfa-secret"]').waitFor();
  const secret = (await nb.page.locator('[data-testid="mfa-secret"]').innerText()).trim();
  ok(/^[A-Z2-7]{32}$/.test(secret), "with the code the authenticator secret appears");
  secrets.newbie = secret;
  await nb.page.locator("input[name=code]").fill(totpAt(secret, Date.now()));
  await nb.page.getByRole("button", { name: "Войти" }).last().click();
  await nb.page.locator('[data-testid="recovery-codes"]').waitFor();
  ok((await nb.page.locator('[data-testid="recovery-codes"] li').count()) === 10, "the person enrols the authenticator app and gets ten recovery codes");
  await nb.page.getByRole("link", { name: /продолжить/ }).click();
  await nb.page.waitForURL((u) => u.pathname === "/");
  ok((await text(nb.page)).includes("Здравствуйте"), "and is in");
  const reuse = await newDevice();
  await passwordLogin(reuse.page, "newbie");
  ok((await reuse.page.locator('[data-testid="enroll-code-form"]').count()) === 0, "the person has a factor now: the next sign-in asks for a code, not for the Owner's code");
  await reuse.ctx.close();
  const codesAfter = (await pool.query("SELECT count(*)::int n FROM bb.enrollment_codes WHERE user_id = $1 AND used_at IS NULL", [users.newbie.id])).rows[0].n;
  ok(codesAfter === 0, "the code is spent");

  console.log("## 2. adding a device needs a FRESH proof (step-up), not just the cookie");
  const m = await newDevice();
  await totpLogin(m.page, "manager");
  await m.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  ok((await m.page.locator('[data-testid="passkeys"]').count()) === 1 && (await m.page.locator('[data-testid="passkey-empty"]').count()) === 1, "the account page offers Face ID / Touch ID, no device yet");
  const bare = await m.page.evaluate(async (base) => {
    const r = await fetch(base + "/api/webauthn/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, BASE);
  ok(bare.status === 403 || bare.status === 401, `a signed-in cookie alone gets nothing from the registration endpoint (${bare.status} ${bare.body.error})`);
  await m.page.locator('input[aria-label="Название устройства"]').fill("Тестовый iPhone");
  await m.page.locator('[data-testid="passkey-add"]').click();
  await m.page.locator('[data-testid="stepup"]').waitFor();
  ok((await m.page.locator('[data-testid="passkey-list"] li').count()) === 0, "pressing «Добавить» first asks to confirm who you are");
  await stepUpWithCode(m.page, "manager");
  await m.page.locator('[data-testid="passkey-message"]').waitFor();
  ok(/Устройство добавлено/.test(await m.page.locator('[data-testid="passkey-message"]').innerText()), "after the code the device is added");
  await m.page.waitForSelector('[data-testid="passkey-list"] li');
  ok((await m.page.locator('[data-testid="passkey-list"] li').first().innerText()).includes("Тестовый iPhone"), "listed with its name");
  const twice = await m.page.evaluate(async (base) => {
    const r = await fetch(base + "/api/webauthn/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return r.status;
  }, BASE);
  ok(twice === 403 || twice === 401, `the proof was spent by that one action (${twice})`);

  console.log("## 3. sign in with the passkey alone (two taps), with the role's rights");
  await m.ctx.clearCookies();
  await m.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
  ok((await text(m.page)).includes("Здравствуйте"), "signed in with the passkey alone");
  const cookie = (await m.ctx.cookies()).find((c) => c.name === "bb_session");
  ok(cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/", "the session cookie is HttpOnly, SameSite=Lax, Path=/");
  const nav = (await m.page.locator("header, nav").first().innerText()).replace(/\s+/g, " ");
  ok(!/Сотрудники|Журнал/.test(nav) && /Посещаемость/.test(nav), "RBAC unchanged: a manager sees the manager's sections");
  await m.page.goto(BASE + "/users", { waitUntil: "load" });
  ok(new URL(m.page.url()).pathname === "/", "and cannot open the staff list");
  ok(((await pool.query("SELECT after->>'passkey' p FROM bb.audit_log WHERE action = 'auth.login' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1", [users.manager.id])).rows[0] ?? {}).p === "true", "the audit log says: sign-in by passkey");

  console.log("## 4. the second-factor page offers the key to a person who typed the password");
  await m.ctx.clearCookies();
  await passwordLogin(m.page, "manager");
  ok((await m.page.locator('[data-testid="passkey-login"]').count()) === 1, "after the password the page offers the key besides the code");
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
  ok((await text(m.page)).includes("Здравствуйте"), "the key finished the sign-in");

  console.log("## 5. origin and RP ID are enforced; the endpoints are guarded");
  {
    const post = (path, origin, extra = {}, body = "{}") => fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...extra }, body });
    ok((await post("/api/webauthn/login/options", "https://evil.example")).status === 403, "a foreign Origin is refused");
    ok((await post("/api/webauthn/login/options", null)).status === 403, "no Origin is refused");
    ok((await post("/api/webauthn/login/options", `http://127.0.0.1:${PORT}`)).status === 403, "the same server under another host name (another origin) is refused");
    ok((await post("/api/webauthn/login/options", BASE, { "content-type": "text/plain" })).status === 415, "not JSON: refused");
    ok((await fetch(`${BASE}/api/webauthn/login/options`)).status === 405, "GET is not allowed");
    ok((await post("/api/webauthn/login/options", BASE)).status === 200, "the configured origin works");
    for (const path of ["/api/webauthn/register/options", "/api/webauthn/revoke", "/api/webauthn/revoke-all", "/api/auth/stepup", "/api/auth/enrollment-code", "/api/webauthn/stepup/options"]) {
      const r = await post(path, BASE);
      ok(r.status === 401 || (r.status >= 300 && r.status < 400), `${path} without a session: refused (${r.status})`);
    }
    const other = await newDevice();
    await other.page.goto(`http://127.0.0.1:${PORT}/login`, { waitUntil: "networkidle" });
    await other.page.locator('[data-testid="passkey-login"]').click();
    await other.page.locator('p[role="alert"]').waitFor();
    ok(/Не удалось войти/.test(await other.page.locator('p[role="alert"]').innerText()) && new URL(other.page.url()).pathname === "/login", "on another host name the button fails with a plain message and nothing is signed in");
    await other.ctx.close();
  }

  console.log("## 6. revoking a key needs a fresh proof too; with the key itself the proof is two taps");
  await m.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  await m.page.locator('[data-testid="passkey-list"] li').first().getByRole("button", { name: "Отозвать" }).click();
  await m.page.locator('[data-testid="stepup"]').waitFor();
  ok((await m.page.locator('[data-testid="passkey-list"] li').count()) === 1, "the key is still there while the proof is pending");
  await m.page.locator('[data-testid="stepup-passkey"]').click();
  await m.page.locator('[data-testid="passkey-message"]').waitFor();
  ok(/Ключ отозван/.test(await m.page.locator('[data-testid="passkey-message"]').innerText()), "step-up with the key itself, then «Ключ отозван»");
  await m.page.waitForSelector('[data-testid="passkey-empty"]');
  await m.ctx.clearCookies();
  await m.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.locator('p[role="alert"]').waitFor();
  ok(new URL(m.page.url()).pathname === "/login", "the revoked key does not sign in");
  await totpLogin(m.page, "manager");
  ok((await text(m.page)).includes("Здравствуйте"), "the fallback (password + code) still works");

  console.log("## 7. the Owner revokes a lost phone's keys (with the Owner's own step-up)");
  const lost = await newDevice();
  await totpLogin(lost.page, "manager");
  await lost.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  await lost.page.locator('[data-testid="passkey-add"]').click();
  await stepUpWithCode(lost.page, "manager");
  await lost.page.locator('[data-testid="passkey-message"]').waitFor();
  await o.page.goto(BASE + "/users", { waitUntil: "networkidle" });
  const box = o.page.locator(`[data-testid="owner-tools-${users.manager.id}"]`);
  ok(/1 устр\./.test(await box.innerText()), "the Owner sees that the manager has 1 device");
  await box.locator('[data-testid="revoke-all"]').click();
  await o.page.locator('[data-testid="stepup"]').waitFor();
  ok(/1 устр\./.test(await box.innerText()), "nothing is revoked before the Owner confirms");
  await stepUpWithCode(o.page, "owner");
  await o.page.getByText(/Ключи Face ID \/ Touch ID отозваны/).waitFor();
  await lost.page.goto(BASE + "/", { waitUntil: "load" });
  ok(new URL(lost.page.url()).pathname === "/login", "the manager's open session ended");
  await lost.ctx.clearCookies();
  await lost.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await lost.page.locator('[data-testid="passkey-login"]').click();
  await lost.page.locator('p[role="alert"]').waitFor();
  ok(new URL(lost.page.url()).pathname === "/login", "the lost phone can no longer sign in");
  const asManager = await newDevice();
  await totpLogin(asManager.page, "manager");
  await asManager.page.goto(BASE + "/users", { waitUntil: "load" });
  ok(new URL(asManager.page.url()).pathname === "/", "a manager never reaches the Owner's tools");
  const audited = (await pool.query("SELECT count(*)::int n FROM bb.audit_log WHERE action IN ('passkey.registered','passkey.revoked','passkey.revoked_all','auth.stepup','enrollment.code_issued','enrollment.code_redeemed')")).rows[0].n;
  ok(audited >= 9, `registrations, step-ups, codes and revocations are in the audit log (${audited})`);

  console.log("## 8. no secrets or personal data in the server's log");
  const all = logs.join("");
  ok(!all.includes(PW) && !all.includes(MFA_KEY) && !all.includes(issued) && !/pk\.(owner|manager|newbie)\.\d+@example/.test(all), "no password, key, enrolment code or e-mail in the log");
} finally {
  await browser.close().catch(() => {});
  stop();
  await pool.end().catch(() => {});
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
