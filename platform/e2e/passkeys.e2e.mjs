// Passkeys (Face ID / Touch ID) in a real browser with a virtual authenticator (Chrome DevTools WebAuthn domain):
// register, sign in without a password, the second-factor page, revocation, the Owner's revocation, the fallback (password + code),
// origin / RP ID rejections and the endpoints' guards. Local database and a local process only; everything is synthetic.
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
const users = {};
const secrets = {};
for (const role of ["owner", "manager"]) {
  users[role] = await createUser(pool, null, { email: `pk.${role}.${Date.now()}@example.test`, name: `PK ${role}`, role, password: PW });
  const e = await beginEnrollment(pool, users[role].id, MFA_KEY);
  await confirmEnrollment(pool, users[role].id, totpAt(e.secret, Date.now()), MFA_KEY);
  secrets[role] = e.secret;
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
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true, ...opts });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp };
}
async function passwordLogin(page, role) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.locator("input[name=email]").fill(users[role].email);
  await page.locator("input[name=password]").fill(PW);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/);
}
async function totpLogin(page, role) {
  await passwordLogin(page, role);
  // a code works once (replay protection): the test clears the "last used step" so it can use the current code again
  await pool.query("UPDATE bb.user_mfa SET last_step = 0 WHERE user_id = $1", [users[role].id]);
  await page.locator("input[name=code]").fill(totpAt(secrets[role], Date.now()));
  await page.getByRole("button", { name: "Войти" }).last().click();
  await page.waitForURL((u) => u.pathname === "/");
}
const text = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");

try {
  console.log("## 0. passkeys are off unless enabled");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${OFF_PORT}/login`, { waitUntil: "networkidle" });
    ok((await page.locator('[data-testid="passkey-login"]').count()) === 0, "the sign-in page shows no passkey button when PASSKEYS_ENABLED is not set");
    const r = await fetch(`http://localhost:${OFF_PORT}/api/webauthn/login/options`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${OFF_PORT}` }, body: "{}" });
    ok(r.status === 404, `the endpoints answer 404 (${r.status})`);
    await ctx.close();
  }

  console.log("## 1. the existing sign-in (password + code) still works and is where a passkey is added");
  const m = await newDevice();
  await totpLogin(m.page, "manager");
  ok((await text(m.page)).includes("Здравствуйте"), "password + code: the dashboard opens");
  await m.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  ok((await m.page.locator('[data-testid="passkeys"]').count()) === 1 && (await m.page.locator('[data-testid="passkey-empty"]').count()) === 1, "the account page offers Face ID / Touch ID, no device yet");

  console.log("## 2. register this device");
  await m.page.locator('input[aria-label="Название устройства"]').fill("Тестовый iPhone");
  await m.page.locator('[data-testid="passkey-add"]').click();
  await m.page.locator('[data-testid="passkey-message"]').waitFor();
  ok(/Устройство добавлено/.test(await m.page.locator('[data-testid="passkey-message"]').innerText()), "«Устройство добавлено»");
  await m.page.waitForSelector('[data-testid="passkey-list"] li');
  ok((await m.page.locator('[data-testid="passkey-list"] li').first().innerText()).includes("Тестовый iPhone"), "the device is listed with its name");
  const row = (await pool.query("SELECT count(*)::int n, bool_and(octet_length(public_key) > 30) pk FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [users.manager.id])).rows[0];
  ok(row.n === 1 && row.pk, "one active key with a public key stored");

  console.log("## 3. sign in with the passkey: no password, no code");
  await m.page.getByRole("button", { name: /Выйти/ }).click().catch(() => {});
  await m.ctx.clearCookies();
  await m.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  ok((await m.page.locator('[data-testid="passkey-login"]').count()) === 1, "the sign-in page offers «Войти с Face ID / Touch ID»");
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
  ok((await text(m.page)).includes("Здравствуйте"), "signed in with the passkey alone");
  const cookie = (await m.ctx.cookies()).find((c) => c.name === "bb_session");
  ok(cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/", "the session cookie is HttpOnly, SameSite=Lax, Path=/");
  const nav = (await m.page.locator("header, nav").first().innerText()).replace(/\s+/g, " ");
  ok(!/Сотрудники|Журнал/.test(nav) && /Посещаемость/.test(nav), "RBAC is unchanged: a manager sees the manager's sections, not the Owner's");
  await m.page.goto(BASE + "/users", { waitUntil: "load" });
  ok(new URL(m.page.url()).pathname === "/", "and cannot open the staff list");
  const audit = (await pool.query("SELECT after->>'passkey' p FROM bb.audit_log WHERE action = 'auth.login' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1", [users.manager.id])).rows[0];
  ok(audit?.p === "true", "the audit log says: sign-in by passkey");

  console.log("## 4. the second-factor page offers the key to a person who typed the password");
  await m.ctx.clearCookies();
  await passwordLogin(m.page, "manager");
  ok((await m.page.locator('[data-testid="passkey-login"]').count()) === 1, "after the password the page offers the key besides the code");
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
  ok((await text(m.page)).includes("Здравствуйте"), "the key finished the sign-in");

  console.log("## 5. origin and RP ID are enforced");
  {
    const post = (origin, extra = {}) => fetch(`${BASE}/api/webauthn/login/options`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...extra }, body: "{}" });
    ok((await post("https://evil.example")).status === 403, "a foreign Origin is refused");
    ok((await post(null)).status === 403, "no Origin is refused");
    ok((await post(`http://127.0.0.1:${PORT}`)).status === 403, "the same server under another host name (another origin) is refused");
    ok((await post(BASE, { "content-type": "text/plain" })).status === 415, "not JSON: refused");
    ok((await fetch(`${BASE}/api/webauthn/login/options`)).status === 405, "GET is not allowed");
    ok((await post(BASE)).status === 200, "the configured origin works");
    const reg = await fetch(`${BASE}/api/webauthn/register/options`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: BASE }, body: "{}" });
    ok(reg.status === 401 || (reg.status >= 300 && reg.status < 400), `registering needs a signed-in person (${reg.status}: refused or sent to the sign-in)`);
    const reg2 = await fetch(`${BASE}/api/webauthn/register/options`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: "bb_session=" + "x".repeat(43) }, body: "{}" });
    ok(reg2.status === 401, "with an invalid session cookie: 401");
    const other = await newDevice();
    await other.page.goto(`http://127.0.0.1:${PORT}/login`, { waitUntil: "networkidle" });
    await other.page.locator('[data-testid="passkey-login"]').click();
    await other.page.locator('p[role="alert"]').waitFor();
    ok(/Не удалось войти/.test(await other.page.locator('p[role="alert"]').innerText()) && new URL(other.page.url()).pathname === "/login", "on another host name the button fails with a plain message and nothing is signed in");
    await other.ctx.close();
  }

  console.log("## 6. revoke a key: it cannot sign in again, the password still can");
  await m.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  await m.page.locator('[data-testid="passkey-list"] li').first().getByRole("button", { name: "Отозвать" }).click();
  await m.page.waitForURL(/notice=passkey_revoked/);
  ok(/Ключ отозван/.test(await text(m.page)) && (await m.page.locator('[data-testid="passkey-empty"]').count()) === 1, "«Ключ отозван», the list is empty");
  await m.ctx.clearCookies();
  await m.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await m.page.locator('[data-testid="passkey-login"]').click();
  await m.page.locator('p[role="alert"]').waitFor();
  ok(new URL(m.page.url()).pathname === "/login", "the revoked key does not sign in");
  await totpLogin(m.page, "manager");
  ok((await text(m.page)).includes("Здравствуйте"), "the fallback (password + code) still works");

  console.log("## 7. the Owner revokes a lost phone's keys");
  const lost = await newDevice();
  await totpLogin(lost.page, "manager");
  await lost.page.goto(BASE + "/account", { waitUntil: "networkidle" });
  await lost.page.locator('[data-testid="passkey-add"]').click();
  await lost.page.locator('[data-testid="passkey-message"]').waitFor();
  const o = await newDevice();
  await totpLogin(o.page, "owner");
  await o.page.goto(BASE + "/users", { waitUntil: "networkidle" });
  const box = o.page.locator(`[data-testid="passkeys-${users.manager.id}"]`);
  ok(/1 устр\./.test(await box.innerText()), "the Owner sees that the manager has 1 device");
  await box.getByRole("button", { name: "Отозвать все ключи" }).click();
  await o.page.waitForURL(/notice=passkeys/);
  ok(/Ключи Face ID \/ Touch ID отозваны/.test(await text(o.page)), "revoked, and the notice says sessions ended");
  await lost.page.goto(BASE + "/", { waitUntil: "load" });
  ok(new URL(lost.page.url()).pathname === "/login", "the manager's open session ended");
  await lost.ctx.clearCookies();
  await lost.page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await lost.page.locator('[data-testid="passkey-login"]').click();
  await lost.page.locator('p[role="alert"]').waitFor();
  ok(new URL(lost.page.url()).pathname === "/login", "the lost phone can no longer sign in");
  const mgrAccount = await newDevice();
  await totpLogin(mgrAccount.page, "manager");
  await mgrAccount.page.goto(BASE + "/users", { waitUntil: "load" });
  ok(new URL(mgrAccount.page.url()).pathname === "/", "a manager never sees the revoke-all control (the staff list is the Owner's)");
  const audited = (await pool.query("SELECT count(*)::int n FROM bb.audit_log WHERE action IN ('passkey.registered','passkey.revoked','passkey.revoked_all')")).rows[0].n;
  ok(audited >= 4, `registrations and revocations are in the audit log (${audited})`);

  console.log("## 8. no secrets or personal data in the server's log");
  const all = logs.join("");
  ok(!all.includes(PW) && !all.includes(MFA_KEY) && !/pk\.(owner|manager)\.\d+@example/.test(all), "no password, key or e-mail in the log");
} finally {
  await browser.close().catch(() => {});
  stop();
  await pool.end().catch(() => {});
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
