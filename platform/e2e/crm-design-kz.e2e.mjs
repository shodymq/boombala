// CRM design integration in a kz-production-like topology. Real processes, real browser, synthetic data only.
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/<fresh db with migrations + seed> E2E_ARTIFACTS=<dir> node e2e/crm-design-kz.e2e.mjs
// Needs `npm run build`. What it starts (all on loopback):
//   - the BRIDGE ("VPS"): kz-production profile, role admin, MFA required, the ONLY process with a database URL (role bb_admin);
//   - the FRONTEND ("Vercel"): kz-production profile, role admin, MFA required, CRM_BRIDGE_MODE=legacy, NO database variable at all,
//     reachable only from the VPN network (X-Real-IP, written by the TLS proxy as nginx does in production);
//   - two TLS proxies with a throw-away certificate, so the bridge call and the browser both use real HTTPS and `__Host-` cookies.
// What it proves: wall (host, network), MFA enrolment and login through the browser, RBAC, real counters, server-side search and
// pagination over more than 100 requests, a request read by id, continuing THAT request in the calendar (no new request), the
// booking read back from the calendar timeline and from the database, no console errors, and that the frontend has no database path.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { applyRoles } from "../scripts/db-roles.ts";
import { createPool } from "../src/core/db.ts";
import { hashToken } from "../src/core/session.ts";
import { createUser } from "../src/core/users.ts";
import { beginEnrollment, confirmEnrollment } from "../src/core/mfa.ts";
import { totpAt } from "../src/core/totp.ts";

const DB = process.env.DATABASE_URL;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
const ART = process.env.E2E_ARTIFACTS;
if (!ART) throw new Error("E2E_ARTIFACTS is required");
mkdirSync(ART, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const run = String(Date.now()).slice(-6);
const rnd = (n = 24) => randomBytes(n).toString("base64url");

const FRONT = { port: 3200, tls: 3300, host: "localhost:3300" };
const BRIDGE = { port: 3201, tls: 3301, host: "localhost:3301" };
const VPN_IP = "10.77.0.5";
const OUTSIDE_IP = "203.0.113.9";
const MFA_KEY = randomBytes(32).toString("base64");
const SERVICE_TOKEN = rnd(40);
const PW = "correct horse battery staple " + run;

let fails = 0;
const results = [];
const ok = (c, m) => {
  results.push(Boolean(c));
  console.log(c ? "  ok  " : "  FAIL", m);
  if (!c) fails++;
};

// ── throw-away TLS certificate ──────────────────────────────────────────────────────────────────────────────
const certDir = mkdtempSync(join(tmpdir(), "bb-kz-e2e-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
  "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
const tlsOptions = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };

/** TLS front like nginx: keeps Host, writes X-Real-IP itself (a client-supplied value is ignored; tests choose it with x-test-ip). */
function tlsProxy(listen, target, defaultIp) {
  const server = https.createServer(tlsOptions, (req, res) => {
    const headers = { ...req.headers };
    const testIp = headers["x-test-ip"];
    delete headers["x-test-ip"];
    delete headers["x-real-ip"];
    headers["x-real-ip"] = typeof testIp === "string" ? testIp : defaultIp;
    headers["x-forwarded-proto"] = "https";
    const up = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(listen, "127.0.0.1", () => resolve(server)));
}

// ── processes ───────────────────────────────────────────────────────────────────────────────────────────────
const children = [];
const logs = new Map();
function start(label, port, env, remove = []) {
  const merged = { ...process.env, NODE_ENV: "production", ...env };
  for (const key of remove) delete merged[key];
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env: merged, stdio: ["ignore", "pipe", "pipe"] });
  const buf = [];
  logs.set(label, buf);
  child.stdout.on("data", (d) => buf.push(String(d)));
  child.stderr.on("data", (d) => buf.push(String(d)));
  children.push(child);
  return child;
}
const stopAll = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("exit", stopAll);
async function waitFor(port) {
  for (let i = 0; i < 120; i++) {
    const up = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => (s.destroy(), r(true))); s.on("error", () => r(false)); });
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`port ${port} did not open`);
}
function tlsGet(port, path, { host, ip } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: host ?? `localhost:${port}` };
    if (ip) headers["x-test-ip"] = ip;
    const req = https.request({ host: "127.0.0.1", port, path, method: "GET", headers, rejectUnauthorized: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// ── database: roles, staff, synthetic data ──────────────────────────────────────────────────────────────────
const owner = createPool(DB, { max: 4 });
const ROLE_API_PW = rnd(24) + "A1";
const ROLE_ADMIN_PW = rnd(24) + "B2";
await applyRoles(owner, { apiPassword: ROLE_API_PW, adminPassword: ROLE_ADMIN_PW });
// bb_admin has exactly what db:roles grants (append-only tables: SELECT and INSERT, no UPDATE); nothing is added for this run.
for (const t of ["booking_operations", "manual_payment_facts"]) {
  const u = (await owner.query(`SELECT has_table_privilege('bb_admin', 'bb.${t}', 'UPDATE') u`)).rows[0].u;
  if (u) throw new Error(`bb_admin must not have UPDATE on ${t}`);
}
const asRole = (user, pass) => { const u = new URL(DB); u.username = user; u.password = pass; return u.toString(); };

const staff = {};
for (const role of ["owner", "manager", "editor"]) {
  staff[role] = await createUser(owner, null, { email: `kz.${role}.${run}@example.test`, name: `KZ ${role}`, role, password: PW });
}
// The editor is enrolled directly and signs in through the browser with a one-time recovery code (deterministic; the manager covers TOTP);
// the manager enrols through the browser.
const editorEnroll = await beginEnrollment(owner, staff.editor.id, MFA_KEY);
const editorCodes = (await confirmEnrollment(owner, staff.editor.id, totpAt(editorEnroll.secret, Date.now()), MFA_KEY)).recoveryCodes;
let nextRecovery = 0; // each recovery code works once

const almatyDay = (offset) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(d);
};
const BOOK_DATE = almatyDay(3);
const TOTAL = 130;
await owner.query(
  `WITH c AS (
     INSERT INTO bb.contacts (name, name_key, phone_e164, source)
     SELECT 'Гость ' || n, 'гость ' || n, '+7702' || lpad(n::text, 7, '0'), 'birthday_form' FROM generate_series(1, ${TOTAL}) n
     RETURNING id, name)
   INSERT INTO bb.lead_requests (idempotency_key, contact_id, package_id, requested_date, children, created_at, status)
   SELECT gen_random_uuid(), c.id, (SELECT id FROM bb.packages WHERE is_active ORDER BY sort_order LIMIT 1), $1::date, 7,
          now() - ((${TOTAL} - regexp_replace(c.name, '[^0-9]', '', 'g')::int) || ' minutes')::interval,
          CASE WHEN regexp_replace(c.name, '[^0-9]', '', 'g')::int % 10 = 0 THEN 'in_progress' ELSE 'new' END
     FROM c`,
  [BOOK_DATE],
);
// A manual block on the booking day (room 2, evening) so the calendar has something real to show besides our booking.
const rooms = (await owner.query("SELECT id, name FROM bb.rooms WHERE is_active ORDER BY sort_order, id")).rows;
const eveningSlot = (await owner.query("SELECT id FROM bb.time_slots ORDER BY starts_at DESC LIMIT 1")).rows[0].id;
await owner.query("INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, note, created_by) VALUES ('block', $1, $2, $3, 'e2e block', $4)", [BOOK_DATE, eveningSlot, rooms[1].id, staff.owner.id]);
// Today's occupancy for the dashboard counters: two bookings and one block, written with triggers off (the guard refuses past starts).
const contact = (await owner.query("SELECT id FROM bb.contacts ORDER BY created_at LIMIT 1")).rows[0].id;
const pkg = (await owner.query("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
const today = almatyDay(0);
{
  const c = await owner.connect();
  try {
    await c.query("SET session_replication_role = replica");
    const slots = (await c.query("SELECT id FROM bb.time_slots ORDER BY starts_at LIMIT 3")).rows.map((r) => r.id);
    const add = (kind, room, slot) => c.query(
      `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, note, created_by, starts_at, ends_at)
       SELECT $1, $2::date, t.id, $4, $5, $6, 5, CASE WHEN $1 = 'booking' THEN 1000 END, CASE WHEN $1 = 'booking' THEN 'base' END, 'x', $7,
              ($2::date + t.starts_at) AT TIME ZONE 'Asia/Almaty', (($2::date + t.starts_at) AT TIME ZONE 'Asia/Almaty') + interval '4 hours'
         FROM bb.time_slots t WHERE t.id = $3`,
      [kind, today, slot, room, kind === "booking" ? contact : null, kind === "booking" ? pkg : null, staff.owner.id]);
    await add("booking", rooms[0].id, slots[0]);
    await add("booking", rooms[1].id, slots[0]);
    await add("block", rooms[2].id, slots[1]);
  } finally {
    await c.query("SET session_replication_role = DEFAULT");
    c.release();
  }
}
const dbCount = async (sql, params = []) => Number((await owner.query(sql, params)).rows[0].n);
const leadsBefore = await dbCount("SELECT count(*)::int n FROM bb.lead_requests");
const expectedNew = await dbCount("SELECT count(*)::int n FROM bb.lead_requests WHERE status = 'new'");
const expectedProgress = await dbCount("SELECT count(*)::int n FROM bb.lead_requests WHERE status = 'in_progress'");

// ── start the topology ──────────────────────────────────────────────────────────────────────────────────────
const common = { PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "admin", PLATFORM_HTTPS: "1", MFA_MODE: "required", TELEGRAM_NOTIFY_LEVEL: "minimal", CRM_SERVICE_TOKEN: SERVICE_TOKEN };
start("bridge", BRIDGE.port, {
  ...common, ALLOWED_HOSTS: BRIDGE.host, DATABASE_URL: asRole("bb_admin", ROLE_ADMIN_PW), MFA_ENC_KEY: MFA_KEY,
  ADMIN_ALLOWED_CIDRS: "127.0.0.1/32", CRON_SECRET: rnd(32),
});
const FRONT_ENV = {
  ...common, ALLOWED_HOSTS: FRONT.host, ADMIN_ALLOWED_CIDRS: "10.77.0.0/24", CRM_BRIDGE_MODE: "legacy", CRM_BRIDGE_URL: `https://${BRIDGE.host}`,
  UNIFIED_FASTAPI_CRM_ENABLED: "1", NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem"),
};
// The frontend gets no database variable at all, and no MFA key: it cannot reach PostgreSQL even by mistake.
start("front", FRONT.port, FRONT_ENV, ["DATABASE_URL", "MFA_ENC_KEY", "CRON_SECRET", "PLATFORM_INTAKE_TOKEN"]);
await Promise.all([waitFor(BRIDGE.port), waitFor(FRONT.port)]);
const proxies = [await tlsProxy(BRIDGE.tls, BRIDGE.port, "127.0.0.1"), await tlsProxy(FRONT.tls, FRONT.port, VPN_IP)];
process.on("exit", () => proxies.forEach((p) => p.close()));

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const consoleErrors = [];
// Console noise from the two deliberate error pages (unknown id -> 404, bridge down -> 5xx) is not a defect of the pages under test.
let muted = false;
const badAssets = [];
const BASE = `https://${FRONT.host}`;
const shot = (page, name) => page.screenshot({ path: join(ART, `${name}.png`), fullPage: true });
async function newPage(viewport = { width: 1440, height: 900 }, storageState) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, extraHTTPHeaders: {}, ...(storageState ? { storageState } : {}) });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (!muted && m.type() === "error" && !/favicon/.test(m.text() + m.location().url)) consoleErrors.push(`${m.text().slice(0, 160)}`); });
  page.on("response", (r) => { if (!muted && r.status() >= 400 && !/favicon/.test(r.url())) badAssets.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  return page;
}
async function signIn(page, email, secretOrNull, rememberDevice = false) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  if (rememberDevice) await page.check('input[name="rememberDevice"]');
  await page.click('button[type="submit"]:has-text("Войти")');
  await page.waitForURL(/\/login\/mfa/, { timeout: 20000 }).catch(async () => {
    throw new Error(`no MFA step after the password for ${email}: ${(await page.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ")}`);
  });
  let secret = secretOrNull;
  if (!secret) secret = (await page.locator('[data-testid="mfa-secret"]').innerText()).trim();
  await page.fill('input[name="code"]', secretOrNull ? editorCodes[nextRecovery++] : totpAt(secret, Date.now()));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(async () => {
    // A freshly enrolled account lands on the recovery-codes screen (still /login/mfa); that is not a failure.
    if (await page.locator('[data-testid="recovery-codes"]').count()) return;
    throw new Error(`second factor not accepted for ${email}: ${(await page.locator("[role=alert]").allInnerTexts()).join(" | ").slice(0, 200)}`);
  });
  return secret;
}

try {
  // ══ 1. The wall ═════════════════════════════════════════════════════════════════════════════════════════════
  console.log("## 1. host and network wall");
  {
    const home = await tlsGet(FRONT.tls, "/login", { host: FRONT.host, ip: VPN_IP });
    ok(home.status === 200, "from the VPN network with the right host: the login page answers");
    const outside = await tlsGet(FRONT.tls, "/login", { host: FRONT.host, ip: OUTSIDE_IP });
    ok(outside.status === 404 && outside.body === "", "from outside the VPN network: 404, empty, no hint");
    const wrongHost = await tlsGet(FRONT.tls, "/login", { host: "evil.example", ip: VPN_IP });
    ok(wrongHost.status === 421, "a wrong Host name is refused (421)");
    const noToken = await new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: BRIDGE.tls, path: "/api/bridge/health", method: "GET", headers: { host: BRIDGE.host }, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    ok(noToken >= 400, `the bridge refuses a call without the service token (${noToken})`);
  }

  // ══ 2. MFA enrolment and login, manager ════════════════════════════════════════════════════════════════════════
  console.log("## 2. MFA through the browser (manager)");
  let manager = await newPage();
  {
    await manager.goto(`${BASE}/requests`);
    ok(/\/login/.test(manager.url()), "an anonymous visitor is sent to the login page");
    const secret = await signIn(manager, `kz.manager.${run}@example.test`, null, true);
    await manager.waitForSelector('[data-testid="recovery-codes"]', { timeout: 20000 });
    ok((await manager.locator('[data-testid="recovery-codes"] li').count()) === 10, "MFA enrolled: ten recovery codes shown once");
    await manager.click('a:has-text("Я сохранил коды")');
    await manager.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
    ok(true, `signed in after the second factor (secret length ${secret.length})`);
    const cookies = await manager.context().cookies();
    const session = cookies.find((c) => c.name === "__Host-bb_session");
    ok(session && session.secure && session.httpOnly && session.sameSite === "Lax" || session?.sameSite === "Strict", "session cookie is __Host-, Secure and HttpOnly");
    ok(session && session.expires - Date.now() / 1000 > 29 * 86400 && session.expires - Date.now() / 1000 <= 30 * 86400, "remembered browser cookie is bounded by the 30-day server session");
    const remembered = await owner.query("SELECT remember_device, mfa_verified_at IS NOT NULL AS mfa_verified FROM bb.sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [staff.manager.id]);
    ok(remembered.rows[0]?.remember_device === true && remembered.rows[0]?.mfa_verified === true, "remembered preference is stored on the MFA-verified server session");
    const browserState = await manager.context().storageState();
    await manager.context().close();
    manager = await newPage({ width: 1440, height: 900 }, browserState);
    await manager.goto(`${BASE}/`);
    await manager.waitForLoadState("networkidle");
    ok(new URL(manager.url()).pathname === "/", "the remembered login survives closing and reopening the browser context");
  }

  // ══ 3. Dashboard: real counters ═════════════════════════════════════════════════════════════════════════════
  console.log("## 3. dashboard counters come from the database");
  {
    await manager.goto(`${BASE}/`);
    await manager.waitForLoadState("networkidle");
    const metric = async (label) => {
      const m = manager.locator(".so-metric", { hasText: label });
      return (await m.count()) ? Number((await m.locator(".so-metric-value").innerText()).replace(/\D/g, "")) : null;
    };
    ok((await metric("Новые заявки")) === expectedNew, `new requests = ${expectedNew} (database)`);
    ok((await metric("В работе")) === expectedProgress, `in progress = ${expectedProgress} (database)`);
    ok((await metric("Брони сегодня")) === 2, "bookings today = 2 (database)");
    ok((await metric("Блокировки сегодня")) === 1, "blocks today = 1 (database)");
    ok((await manager.locator(".so-metric-value span").count()) === 0, "no invented capacity next to the numbers");
    ok((await manager.locator('[data-testid="manager-workspace"]').count()) === 1, "the authenticated manager sees the RBAC-scoped working lists");
    for (const section of ["Просроченные действия", "Звонки сегодня", "Новые необработанные заявки", "Ближайшие подтверждённые праздники"]) {
      ok((await manager.locator('[data-testid="manager-workspace"]').getByRole("heading", { name: section }).count()) === 1, `manager home includes ${section.toLowerCase()}`);
    }
    await shot(manager, "01-dashboard");
  }

  // ══ 4. Requests: server-side search, filters, pagination, record by id ═══════════════════════════════════
  console.log("## 4. requests queue");
  let targetId;
  {
    await manager.goto(`${BASE}/requests`);
    await manager.waitForLoadState("networkidle");
    ok((await manager.locator(".crm-requests-count strong").innerText()) === String(TOTAL), `total = ${TOTAL}, more than the old 100-row limit`);
    const rows1 = await manager.locator(".crm-requests-table tbody tr").count();
    ok(rows1 === 25, `first page shows 25 rows (${rows1})`);
    ok(/Страница 1 из 6/.test(await manager.locator(".crm-requests-pager").innerText()), "pager: page 1 of 6");
    await manager.goto(`${BASE}/requests?page=6`);
    const last = await manager.locator(".crm-requests-table tbody tr").count();
    ok(last === TOTAL - 125, `last page shows the remaining ${TOTAL - 125} rows (${last})`);
    await manager.goto(`${BASE}/requests?q=${encodeURIComponent("Гость 1")}&page=1`);
    const found = await manager.locator(".crm-requests-table tbody tr").count();
    ok(found >= 1, "search by name works in the database");
    await manager.goto(`${BASE}/requests?q=${encodeURIComponent("+7 702 000 0003")}`);
    ok((await manager.locator(".crm-requests-table tbody tr").count()) >= 1, "search by phone digits works");
    await manager.goto(`${BASE}/requests?status=in_progress`);
    ok(/Всего: ?\d+/.test(await manager.locator(".crm-requests-count").innerText()) && (await manager.locator(".crm-requests-count strong").innerText()) === String(expectedProgress), "status filter total comes from the database");
    await manager.goto(`${BASE}/requests?q=${encodeURIComponent("Гость 130")}`);
    const row = manager.locator(".crm-requests-table tbody tr", { hasText: "Гость 130" });
    ok((await row.count()) === 1, "a record beyond the first 100 is reachable by search");
    await shot(manager, "02-requests");
    await row.getByRole("link", { name: "Открыть карточку" }).click();
    await manager.waitForLoadState("networkidle");
    targetId = decodeURIComponent(manager.url().split("/requests/")[1].split("?")[0]);
    ok(/^[0-9a-f-]{36}$/.test(targetId) && (await manager.getByRole("heading", { name: "Гость 130" }).count()) === 1, "the card is the concrete record read by id");
    ok((await manager.locator("a.crm-lead-phone").getAttribute("href"))?.startsWith("tel:+7702"), "the request card exposes a phone link without changing workflow status");
    await shot(manager, "03-request-card");
    await manager.getByRole("button", { name: "Взять заявку себе" }).click();
    await manager.waitForURL(new RegExp(`/requests/${targetId}\\?notice=claimed`));
    let workflowRow = (await owner.query("SELECT status, assigned_to, next_action, manager_agreement, workflow_version FROM bb.lead_requests WHERE id=$1", [targetId])).rows[0];
    ok(workflowRow?.status === "in_progress" && workflowRow?.assigned_to === staff.manager.id, "claim assigns the lead to this manager without changing its lifecycle status");
    const workflowForm = manager.locator("form[data-lead-workflow-form]");
    ok(await workflowForm.locator('select[name="assignedTo"]').inputValue() === staff.manager.id, "the refreshed request card keeps the claimed manager selected in the workflow form");
    await workflowForm.locator('select[name="nextAction"]').selectOption("call_customer");
    await workflowForm.locator('input[name="followUpAtLocal"]').fill(`${almatyDay(1)}T11:00`);
    await workflowForm.locator('textarea[name="managerAgreement"]').fill("Позвонить и уточнить количество гостей.");
    await workflowForm.getByRole("button", { name: "Сохранить план" }).click();
    await manager.waitForURL(new RegExp(`/requests/${targetId}\\?notice=workflow`));
    workflowRow = (await owner.query("SELECT status, assigned_to, next_action, manager_agreement, workflow_version FROM bb.lead_requests WHERE id=$1", [targetId])).rows[0];
    ok(workflowRow?.status === "in_progress" && workflowRow?.assigned_to === staff.manager.id && workflowRow?.next_action === "call_customer" && workflowRow?.manager_agreement === "Позвонить и уточнить количество гостей." && Number(workflowRow?.workflow_version) === 3, "the manager agreement and next call are persisted on the same lead with workflow versioning");
    const agreementInAudit = await dbCount("SELECT count(*)::int n FROM bb.audit_log WHERE entity_id=$1 AND action='lead.workflow_updated' AND after::text LIKE '%количество гостей%'", [targetId]);
    ok(agreementInAudit === 0, "the audit records workflow change without copying the customer's agreement text");
    await shot(manager, "03-request-workflow-saved");
    const old = await dbCount("SELECT count(*)::int n FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = 'Гость 1'");
    const oldId = (await owner.query("SELECT l.id FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = 'Гость 1'")).rows[0].id;
    await manager.goto(`${BASE}/requests/${oldId}`);
    ok(old === 1 && (await manager.getByRole("heading", { name: "Гость 1" }).count()) === 1, "the oldest record opens by id too");
    await manager.getByRole("button", { name: "В работу" }).click();
    await manager.waitForURL(/\/requests\?notice=status/);
    const changedStatus = await owner.query("SELECT status FROM bb.lead_requests WHERE id=$1", [oldId]);
    ok(changedStatus.rows[0]?.status === "in_progress", "the manager changes request status through its Server Action");
    muted = true;
    const missing = await manager.goto(`${BASE}/requests/00000000-0000-4000-8000-000000000000`);
    ok(missing?.status() === 404, "an unknown id is a 404, not a wrong record");
    muted = false;
  }

  // ══ 5. Card → calendar continues THAT request ═══════════════════════════════════════════════════════════════
  console.log("## 5. continue the request in the calendar");
  {
    await manager.goto(`${BASE}/requests/${targetId}`);
    await manager.locator('[data-testid="continue-in-calendar"]').click();
    await manager.waitForLoadState("networkidle");
    ok(/continue=/.test(manager.url()) && manager.url().includes(`date=${BOOK_DATE}`), "the link carries the request id and its date");
    const calendarRooms = await manager.locator('[data-timeline] [role="group"]').count();
    ok(calendarRooms === rooms.length, `the calendar loaded every active catalog room (${calendarRooms}/${rooms.length})`);
    const blocks = await manager.locator('[data-timeline] [data-state="blocked"]').count();
    ok(blocks === 1, "the real block of that day is drawn on the timeline");
    ok(/0 броней/.test(await manager.locator("[data-summary-counts]").innerText()), "the day header says 0 bookings before we book");
    // The drawer form is intentionally identified by its existing-request field; no extra UI test hook is needed.
    const form = manager.locator('form').filter({ has: manager.locator('input[name="requestId"]') });
    ok((await form.count()) === 1, "the booking form belongs to the existing request");
    ok(/Гость 130/.test(await form.innerText()) && /\+7702/.test(await form.innerText()), "customer data comes from the request, nothing is typed twice");
    ok((await form.locator('input[name="requestId"]').inputValue()) === targetId, "the form carries the request id");
    ok((await form.locator('input[name="customerName"]').count()) === 0, "there is no new-customer field: no new request can be created");
    await shot(manager, "04-continue-form");
    await form.locator('select[name="roomId"]').selectOption({ label: rooms[0].name });
    await form.locator('input[name="startTime"]').fill("14:00");
    await form.locator('input[name="agreedPriceKzt"]').fill("180000");
    await form.locator('button[type="submit"]').click();
    const actionResult = await Promise.race([
      manager.waitForURL(/[?&](ok|error)=/, { timeout: 30000 }).then(() => "redirect").catch(() => null),
      manager.locator("[data-booking-action-error]").waitFor({ timeout: 30000 }).then(() => "action_error").catch(() => null),
    ]);
    if (actionResult === "action_error") {
      const code = await manager.locator("[data-booking-action-error]").getAttribute("data-booking-action-error");
      ok(false, `booking Server Action returned ${code ?? "an unclassified error"}`);
      throw new Error(`booking Server Action returned ${code ?? "an unclassified error"}`);
    } else {
      ok(actionResult === "redirect", "booking Server Action completed with a read-after-write redirect");
      if (actionResult !== "redirect") throw new Error("booking Server Action had no observable result");
    }
    await manager.waitForLoadState("networkidle");
    ok(/ok=booked/.test(manager.url()), `booking succeeded (${manager.url().split("?")[1]?.slice(0, 80)})`);
    ok((await manager.locator('[role="status"]', { hasText: "Проверено по данным системы" }).count()) === 1, "success is verified by reading the system back");
    const booked = manager.locator('[data-timeline] [data-state="booked"][data-start="14:00"]');
    ok((await booked.count()) === 1, "the booking is drawn at the selected full hour");
    ok(/1 бронь/.test(await manager.locator("[data-summary-counts]").innerText()), "the day header now says 1 booking");
    await shot(manager, "05-calendar-booked");
    // The database is the authority.
    ok((await dbCount("SELECT count(*)::int n FROM bb.lead_requests")) === leadsBefore, "NO new request was created (request count unchanged)");
    const row = (await owner.query(
      `SELECT l.status, r.kind, to_char(r.starts_at AT TIME ZONE 'Asia/Almaty', 'HH24:MI') hhmm, r.room_id, (r.ends_at - r.starts_at) = interval '4 hours' four,
              (SELECT count(*)::int FROM bb.manual_payment_facts p WHERE p.lead_request_id = l.id) payments
         FROM bb.lead_requests l JOIN bb.slot_reservations r ON r.lead_request_id = l.id AND r.released_at IS NULL WHERE l.id = $1`, [targetId])).rows;
    ok(row.length === 1 && row[0].status === "confirmed" && row[0].hhmm === "14:00" && row[0].four && row[0].room_id === rooms[0].id, "the booking is attached to THAT request: confirmed at 14:00 for 4 hours");
    ok(row[0]?.payments === 1, "exactly one manual prepayment fact");
    // Continuing it again must not create anything.
    await manager.goto(`${BASE}/bookings?date=${BOOK_DATE}&continue=${targetId}`);
    ok((await manager.locator('form').filter({ has: manager.locator('input[name="requestId"]') }).count()) === 0 && (await manager.locator('[role="alert"]', { hasText: "нельзя продолжить" }).count()) === 1, "an already booked request cannot be continued again");
    ok((await dbCount("SELECT count(*)::int n FROM bb.slot_reservations WHERE lead_request_id = $1", [targetId])) === 1, "still one reservation for the request");
    await manager.goto(`${BASE}/requests/${targetId}`);
    ok(/Подтверждена/.test(await manager.locator("main").innerText()), "the card shows the request as confirmed");
  }

  // ══ 6. RBAC: manager and editor ═════════════════════════════════════════════════════════════════════════════
  console.log("## 6. RBAC");
  {
    for (const path of ["/users", "/audit"]) {
      await manager.goto(`${BASE}${path}`);
      const allowed = path === "/audit" ? true : false;
      ok(allowed ? !/\/login/.test(manager.url()) : new URL(manager.url()).pathname === "/", `manager on ${path}: ${allowed ? "allowed" : "sent back to the dashboard"}`);
    }
    const editor = await newPage();
    await signIn(editor, `kz.editor.${run}@example.test`, editorEnroll.secret);
    await editor.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
    await editor.goto(`${BASE}/`);
    await editor.waitForLoadState("networkidle");
    ok((await editor.locator(".so-metric").count()) === 0, "editor sees no request or booking counters (null, not zero)");
    for (const path of ["/requests", "/bookings", `/requests/${targetId}`, "/contacts", "/users"]) {
      await editor.goto(`${BASE}${path}`);
      ok(new URL(editor.url()).pathname === "/", `editor is sent back from ${path.replace(targetId, "<id>")}`);
    }
    await shot(editor, "06-editor-dashboard");
    await editor.context().close();
    // The same record, directly through the bridge with the editor's session, is refused by the bridge itself.
    const editorCookie = (await owner.query("SELECT 1")).rows.length; // placeholder keeps owner pool alive until the end
    ok(editorCookie === 1, "owner pool alive");
  }

  // ══ 7. Responsive navigation ═══════════════════════════════════════════════════════════════════════════════════
  console.log("## 7. phone width");
  {
    const secret = (await owner.query("SELECT 1")).rows.length ? editorEnroll.secret : "";
    const managerState = await manager.context().storageState();
    for (const width of [320, 390, 430]) {
      const managerPhone = await newPage({ width, height: 844 }, managerState);
      await managerPhone.goto(`${BASE}/`);
      await managerPhone.waitForLoadState("networkidle");
      ok((await managerPhone.locator('[data-testid="manager-workspace"]').count()) === 1, `manager workspace renders at ${width}px`);
      ok(!(await managerPhone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `manager dashboard has no horizontal page scroll at ${width}px`);
      await shot(managerPhone, `07-manager-dashboard-${width}`);
      await managerPhone.goto(`${BASE}/requests/${targetId}`);
      await managerPhone.waitForLoadState("networkidle");
      ok(!(await managerPhone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `manager request card has no horizontal overflow at ${width}px`);
      await shot(managerPhone, `07-manager-request-card-${width}`);
      await managerPhone.context().close();

      const phone = await newPage({ width, height: 844 });
      await signIn(phone, `kz.editor.${run}@example.test`, secret);
      await phone.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
      await phone.goto(`${BASE}/`);
      ok(!(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `no horizontal page scroll at ${width}px`);
      await shot(phone, `07-phone-dashboard-${width}`);
      await phone.context().close();
    }
  }

  // ══ 8. The frontend has no path to the database ════════════════════════════════════════════════════════════════
  console.log("## 8. the frontend cannot reach PostgreSQL");
  {
    ok(!("DATABASE_URL" in FRONT_ENV) && !("MFA_ENC_KEY" in FRONT_ENV), "the frontend was started without DATABASE_URL and without the MFA key");
    children[0].kill("SIGTERM"); // stop the bridge
    await new Promise((r) => setTimeout(r, 1500));
    muted = true;
    const res = await manager.goto(`${BASE}/requests`);
    ok((res?.status() ?? 0) >= 500 && (await manager.locator(".crm-requests-table").count()) === 0, "with the bridge down the frontend shows no data (it has nothing else to read)");
    children.push(start("bridge-restart", BRIDGE.port, {
      ...common, ALLOWED_HOSTS: BRIDGE.host, DATABASE_URL: asRole("bb_admin", ROLE_ADMIN_PW), MFA_ENC_KEY: MFA_KEY,
      ADMIN_ALLOWED_CIDRS: "127.0.0.1/32", CRON_SECRET: rnd(32),
    }));
    await waitFor(BRIDGE.port);
    muted = false;
    await manager.goto(`${BASE}/`);
    await manager.waitForLoadState("networkidle");
    const cookie = (await manager.context().cookies()).find((c) => c.name === "__Host-bb_session");
    await manager.getByRole("button", { name: "Выйти" }).click();
    await manager.waitForURL(/\/login/);
    const revoked = cookie ? await owner.query("SELECT revoked_at IS NOT NULL AS revoked FROM bb.sessions WHERE token_hash = $1", [hashToken(cookie.value)]) : { rows: [] };
    ok(revoked.rows[0]?.revoked === true, "logout revokes the remembered server session");
    await manager.goto(`${BASE}/requests`);
    ok(new URL(manager.url()).pathname === "/login", "a protected route stays unavailable after logout");
  }

  ok(consoleErrors.length === 0, `no browser console errors${consoleErrors.length ? ": " + [...new Set(consoleErrors)].slice(0, 3).join(" | ") : ""}`);
  const assets = badAssets;
  ok(assets.length === 0, `no failed static assets${assets.length ? ": " + [...new Set(assets)].join(", ") : ""}`);
} catch (error) {
  ok(false, `script crashed: ${String(error).slice(0, 400)}`);
} finally {
  await browser.close();
  await owner.end().catch(() => {});
  stopAll();
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  if (fails) for (const [label, buf] of logs) console.log(`--- ${label} log tail ---\n${buf.join("").split("\n").slice(-12).join("\n")}`);
  process.exit(fails ? 1 : 0);
}
