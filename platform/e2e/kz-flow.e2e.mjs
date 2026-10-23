// The happy path of the Kazakhstan production contour, end to end, with real processes and a real browser:
//   public site (SITE_PROFILE=kz-production, strict) → API process (role api, bb_api) → PostgreSQL → staff process
//   (role admin, MFA, VPN allowlist, bb_admin) → /attendance and /requests, plus the Telegram outbox ("minimal").
//   DATABASE_URL=postgres://postgres@127.0.0.1:54331/bb_kz npm run e2e:kz-flow
// Needs a FRESH database (no published documents): drop/create it and run `npm run db:migrate` first.
// Needs: platform built (`npm run build`), the site built (`npm run build` in the repo root), a LOCAL database with
// migrations applied, and the approved legal texts in ~/.boombala-backups/legal-release (they stay out of the repository).
// Everything is synthetic and local; Telegram is a stand-in that records what it receives. It proves the CODE and its
// configuration profile. It does not prove the server, nginx, TLS, DNS or the firewall (deploy/kz/scripts/verify-isolation.sh does).
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { applyRoles } from "../scripts/db-roles.ts";
import { createUser } from "../src/core/users.ts";
import { beginEnrollment, confirmEnrollment } from "../src/core/mfa.ts";
import { createPool } from "../src/core/db.ts";
import { totpAt } from "../src/core/totp.ts";

const DB = process.env.DATABASE_URL;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
const root = new URL("..", import.meta.url).pathname;
const repo = new URL("../..", import.meta.url).pathname;
const LEGAL_DIR = process.env.LEGAL_DIR ?? `${process.env.HOME}/.boombala-backups/legal-release`;
if (!existsSync(`${LEGAL_DIR}/visit-rules.md`)) throw new Error("the approved legal texts are not at LEGAL_DIR");
const run = String(Date.now()).slice(-6);
const rnd = (n = 24) => randomBytes(n).toString("base64url");

const API = { port: 3301, host: "127.0.0.1:3301" };
const ADMIN = { port: 3302, host: "127.0.0.1:3302" };
const SITE = { port: 3303, host: "127.0.0.1:3303" };
const API_DBDOWN = { port: 3304, host: "127.0.0.1:3304" };
const SITE_DOWN = { port: 3305, host: "127.0.0.1:3305" };
const TG_PORT = 3309;
const VPN_IP = "10.77.0.5";
const MFA_KEY = randomBytes(32).toString("base64");
const INTAKE = rnd(32);
const CRON = rnd(32);
const PW = "correct horse battery staple " + run;
const ROLE_API_PW = rnd(24) + "A1";
const ROLE_ADMIN_PW = rnd(24) + "B2";
const ADULT = `ТЕСТ KZ взрослый ${run}`;
const LEAD_NAME = `ТЕСТ KZ заявка ${run}`;
const LEAD_PHONE = "+77015550" + run.slice(-3).replace(/\D/g, "0").padStart(3, "0");

let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
const children = new Map();
const logs = new Map();
function start(label, cwd, port, env) {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd, env: { ...process.env, NODE_ENV: "production", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const buf = [];
  logs.set(label, buf);
  child.stdout.on("data", (d) => buf.push(String(d)));
  child.stderr.on("data", (d) => buf.push(String(d)));
  children.set(label, child);
}
const stopAll = () => [...children.values()].forEach((c) => c.kill("SIGTERM"));
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
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
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

// ── database, roles, one Owner and one enrolled Manager ─────────────────────────────────────────────────────
const owner = createPool(DB, { max: 3 });
await applyRoles(owner, { apiPassword: ROLE_API_PW, adminPassword: ROLE_ADMIN_PW });
const asRole = (user, pass, port) => {
  const u = new URL(DB);
  u.username = user;
  u.password = pass;
  if (port) u.port = String(port);
  return u.toString();
};
// The deployment order: migrations -> db:roles (applied above) -> preflight -> seed -> preflight. The preflight must notice a missing catalog.
const tool = (script, args = [], env = {}) => execFileSync("node", ["--no-warnings", script, ...args], { cwd: root, env: { ...process.env, DATABASE_URL: DB, ...env }, stdio: "pipe" }).toString();
let unseeded = "";
try { tool("scripts/preflight.ts"); } catch (e) { unseeded = String(e.stderr ?? ""); }
ok(/catalog_not_seeded/.test(unseeded), "preflight refuses a database whose catalog was not seeded");
tool("scripts/seed.ts");
ok(/preflight: OK/.test(tool("scripts/preflight.ts")), "after db:seed the preflight is OK");
const ownerUser = await createUser(owner, null, { email: `kz.owner.${run}@example.test`, name: "KZ owner", role: "owner", password: PW });
const mgr = await createUser(owner, null, { email: `kz.manager.${run}@example.test`, name: "KZ manager", role: "manager", password: PW });
const enr = await beginEnrollment(owner, mgr.id, MFA_KEY);
await confirmEnrollment(owner, mgr.id, totpAt(enr.secret, Date.now()), MFA_KEY);

// A stand-in for Telegram that records every message it is given. The real service is never contacted.
const tgMessages = [];
const telegram = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    tgMessages.push(b);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: tgMessages.length } }));
  });
});
await new Promise((r) => telegram.listen(TG_PORT, "127.0.0.1", r));

const clean = { DATABASE_URL: "", TELEGRAM_NOTIFY_LEVEL: "", TELEGRAM_API_BASE: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", LEAD_PIPELINE: "", SITE_PROFILE: "", PLATFORM_URL: "", PLATFORM_INTAKE_TOKEN: "", PLATFORM_IP_PEPPER: "", MFA_ENC_KEY: "", MFA_MODE: "", CRON_SECRET: "", PII_INTAKE_ENABLED: "", CONSENT_FORM_ENABLED: "", PLATFORM_PROFILE: "", PLATFORM_ROLE: "", ALLOWED_HOSTS: "", ADMIN_ALLOWED_CIDRS: "", PLATFORM_HTTPS: "", REVALIDATE_TOKEN: "", SITE_REVALIDATE_URL: "" };
const apiEnv = { ...clean, PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "api", PLATFORM_HTTPS: "1", ALLOWED_HOSTS: API.host, PLATFORM_INTAKE_TOKEN: INTAKE, PLATFORM_IP_PEPPER: rnd(24), DATABASE_POOL_MAX: "3" };
start("api", root, API.port, { ...apiEnv, DATABASE_URL: asRole("bb_api", ROLE_API_PW), PII_INTAKE_ENABLED: "1" });
// the same API with its database unreachable (a closed port): what the site does when the database is gone
start("api-dbdown", root, API_DBDOWN.port, { ...apiEnv, ALLOWED_HOSTS: API_DBDOWN.host, DATABASE_URL: asRole("bb_api", ROLE_API_PW, 1), PII_INTAKE_ENABLED: "1" });
start("admin", root, ADMIN.port, {
  ...clean, PLATFORM_PROFILE: "kz-production", PLATFORM_ROLE: "admin", PLATFORM_HTTPS: "1", ALLOWED_HOSTS: ADMIN.host, DATABASE_URL: asRole("bb_admin", ROLE_ADMIN_PW),
  MFA_MODE: "required", MFA_ENC_KEY: MFA_KEY, ADMIN_ALLOWED_CIDRS: "10.77.0.0/24,127.0.0.1/32", CRON_SECRET: CRON, TELEGRAM_NOTIFY_LEVEL: "minimal",
  TELEGRAM_BOT_TOKEN: "1:abcdef", TELEGRAM_CHAT_ID: "1", TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`, DATABASE_POOL_MAX: "3",
});
const siteEnv = { ...clean, SITE_PROFILE: "kz-production", LEAD_PIPELINE: "strict", PLATFORM_INTAKE_TOKEN: INTAKE, CONSENT_FORM_ENABLED: "1", NEXT_PUBLIC_SITE_URL: `http://${SITE.host}` };
start("site", repo, SITE.port, { ...siteEnv, PLATFORM_URL: `http://${API.host}` });
start("site-down", repo, SITE_DOWN.port, { ...siteEnv, PLATFORM_URL: `http://${API_DBDOWN.host}` });
await Promise.all([API, API_DBDOWN, ADMIN, SITE, SITE_DOWN].map((p) => waitFor(p.port)));

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const q = async (s, p = []) => (await owner.query(s, p)).rows;
const postJson = (port, host, path, obj, extra = {}) => raw(port, path, { method: "POST", host, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(obj) });

try {
  console.log("## 1. no published consent: the form and the API refuse, nothing is stored");
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
    await page.goto(`http://${SITE.host}/consent`, { waitUntil: "networkidle" });
    ok((await page.locator("form").count()) === 0, "/consent shows no working form while the documents are not published");
    const r = await postJson(SITE.port, SITE.host, "/api/consent", { name: ADULT, childrenCount: 3, documentVersions: { visit_rules: 1, personal_data_consent: 1 }, acceptRules: true, acceptPersonalData: true, idempotencyKey: crypto.randomUUID() });
    ok(r.status >= 400 && r.status < 600, `POST /api/consent without published documents is refused (${r.status})`);
    ok((await q("SELECT count(*)::int n FROM bb.contacts WHERE name = $1", [ADULT]))[0].n === 0, "nothing was stored");
  }

  console.log("## 2. the owner's texts are loaded and published (as the Owner, through the loader)");
  tool("scripts/legal-load.ts", ["--dir", LEGAL_DIR, "--publish"], { OWNER_EMAIL: ownerUser.email });
  const pub = await q("SELECT kind::text kind, version v FROM bb.legal_documents WHERE status = 'published'");
  ok(pub.some((d) => d.kind === "visit_rules") && pub.some((d) => d.kind === "personal_data_consent"), "visit_rules and personal_data_consent are published");
  const docs = await q("SELECT kind::text kind, body FROM bb.legal_documents WHERE status = 'published'");
  const rules = docs.find((d) => d.kind === "visit_rules").body;
  ok(/15 минут с момента оплаты/.test(rules) && /төлем жасалған сәттен бастап 15 минут/.test(rules), "the rules carry the 15-minute refund from the moment of payment, in Russian and in Kazakh");
  const pdc = docs.find((d) => d.kind === "personal_data_consent").body;
  ok(["имя", "телефон", "количество детей", "хеш IP", "user-agent"].every((w) => pdc.includes(w)) && /Қазақша/.test(pdc), "the consent lists the real fields (name, phone, children count, IP hash, user-agent) in both languages");
  ok(!/08_|Release Gates|INTERNAL|\[ТРЕБУЕТСЯ/.test(rules + pdc), "no internal instructions or placeholders in the public texts");

  console.log("## 3. a parent registers on a phone: 1 adult, 3 children, NO phone; two separate ticks");
  // nginx writes x-real-ip in production (the app listens on loopback); the test stands in for it
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-real-ip": "198.51.100.7" } });
  const page = await pctx.newPage();
  let payload = null;
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/consent")) payload = JSON.parse(r.postData()); });
  await page.goto(`http://${SITE.host}/consent`, { waitUntil: "networkidle" });
  ok((await page.locator('input[name="acceptRules"]').isChecked()) === false && (await page.locator('input[name="acceptPersonalData"]').isChecked()) === false, "both ticks start empty");
  ok((await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), "mobile: no horizontal scroll");
  await page.locator('input[name="name"]').fill(ADULT);
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Увеличить количество детей" }).click();
  await page.locator('input[name="acceptPersonalData"]').check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.waitForTimeout(600);
  ok((await q("SELECT count(*)::int n FROM bb.contacts WHERE name = $1", [ADULT]))[0].n === 0, "only the data consent ticked: nothing saved (the ticks are not merged)");
  await page.locator('input[name="acceptRules"]').check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 15000 });
  ok(payload.childrenCount === 3 && !("phone" in payload), "payload: 3 children, no phone");
  const reg = (await q("SELECT r.id, r.children_count, c.phone_e164 FROM bb.consent_registrations r JOIN bb.contacts c ON c.id = r.contact_id WHERE r.idempotency_key = $1", [payload.idempotencyKey]))[0];
  ok(reg && reg.children_count === 3 && reg.phone_e164 === null, "PostgreSQL: one registration, children_count = 3, phone NULL");
  const ev = await q("SELECT d.kind::text kind, d.version v, e.event, e.ip_hash, e.user_agent FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id WHERE e.registration_id = $1", [reg.id]);
  ok(ev.length === 2 && ev.every((e) => e.event === "given" && pub.some((p) => p.kind === e.kind && p.v === e.v)), "two separate consent rows, each with the exact published edition");
  ok(ev.every((e) => /^[0-9a-f]{32}$/.test(e.ip_hash ?? "")), "the IP is stored only as a hash");

  console.log("## 4. staff (second factor, inside the VPN): /attendance shows 1 registration and 2 entries, not 3");
  const A = `http://${ADMIN.host}`;
  const actx = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": VPN_IP }, viewport: { width: 1200, height: 800 } });
  const admin = await actx.newPage();
  await admin.goto(A + "/login", { waitUntil: "networkidle" });
  await admin.locator("input[name=email]").fill(mgr.email);
  await admin.locator("input[name=password]").fill(PW);
  await admin.getByRole("button", { name: "Войти" }).click();
  await admin.waitForURL(/\/login\/mfa/);
  await admin.locator("input[name=code]").fill(totpAt(enr.secret, Date.now() + 30_000));
  await admin.getByRole("button", { name: "Войти" }).click();
  await admin.waitForURL((u) => u.pathname === "/");
  const card = async (id) => Number((await admin.locator(`[data-testid=${id}] p`).nth(1).innerText()).trim());
  const figures = async () => { await admin.goto(A + "/attendance", { waitUntil: "networkidle" }); return { adults: await card("card-adults"), expected: await card("card-expected"), entered: await card("card-entered"), entries: await card("card-entries") }; };
  const f1 = await figures();
  ok(f1.adults === 1 && f1.expected === 3 && f1.entered === 0 && f1.entries === 0, `after registering: 1 adult, 3 expected, 0 entered (${JSON.stringify(f1)})`);
  const li = admin.locator("li[data-registration]", { hasText: ADULT });
  await li.locator('input[name="childrenCount"]').fill("2");
  await li.getByRole("button", { name: "Подтвердить вход" }).click();
  await admin.waitForURL(/notice=confirmed/);
  const f2 = await figures();
  ok(f2.adults === 1 && f2.entered === 2 && f2.entries === 1 && f2.expected === 0, `after confirming 2: 1 adult, 2 entered, 1 entry, 0 expected (${JSON.stringify(f2)})`);

  console.log("## 5. no duplicates; entry without QR and without name or phone");
  const again = await postJson(SITE.port, SITE.host, "/api/consent", payload);
  ok(again.status === 200, "the same registration request again: 200");
  ok(JSON.stringify(await figures()) === JSON.stringify(f2), "the figures did not move");
  ok((await q("SELECT count(*)::int n FROM bb.consent_registrations WHERE idempotency_key = $1", [payload.idempotencyKey]))[0].n === 1 && (await q("SELECT count(*)::int n FROM bb.consent_events WHERE registration_id = $1", [reg.id]))[0].n === 2, "one registration, two consent rows");
  const man = admin.locator("[data-testid=manual-form]");
  ok((await man.locator('input[name="name"], input[type="tel"]').count()) === 0, "the manual form has no name or phone field");
  await man.locator('input[name="childrenCount"]').fill("1");
  await man.getByRole("button", { name: "Записать вход" }).click();
  await admin.waitForURL(/notice=manual/);
  const f3 = await figures();
  ok(f3.entered === 3 && f3.entries === 2 && f3.adults === 1, `manual entry: entered 3, entries 2, adults still 1 (${JSON.stringify(f3)})`);

  console.log("## 6. CRM: a birthday enquiry from the site lands in /requests; Telegram gets no name and no phone");
  const leadBody = { name: LEAD_NAME, phone: LEAD_PHONE, date: "2099-06-01", package: "wow-party", consent: true, idempotencyKey: crypto.randomUUID() };
  const lead = await postJson(SITE.port, SITE.host, "/api/lead", leadBody, { "x-real-ip": "198.51.100.8" });
  if (lead.status !== 200) console.log("   site log:", (logs.get("site").join("").match(/\[lead\][^\n]*/g) ?? []).join(" | ").slice(0, 300), "| api log:", (logs.get("api").join("").match(/[^\n]*(error|Error|invalid)[^\n]{0,160}/g) ?? []).slice(-3).join(" | ").replace(/\d{9,}/g, "#"));
  ok(lead.status === 200, `the strict site saves the enquiry in the platform (${lead.status})`);
  ok(tgMessages.length === 0, "the site itself sent nothing to Telegram");
  await admin.goto(A + "/requests", { waitUntil: "networkidle" });
  ok((await admin.locator("main").innerText()).includes(LEAD_NAME), "the enquiry is visible in /requests for staff");
  const cron = await raw(ADMIN.port, "/api/cron/outbox", { host: ADMIN.host, ip: "127.0.0.1", headers: { authorization: `Bearer ${CRON}` } });
  ok(cron.status === 200, `the outbox worker runs (${cron.status})`);
  ok(tgMessages.length >= 1, `Telegram stand-in received ${tgMessages.length} notification(s)`);
  const phoneDigits = LEAD_PHONE.replace(/\D/g, "");
  ok(tgMessages.every((m) => !m.includes(LEAD_NAME) && !m.includes(ADULT) && !m.includes(phoneDigits) && !m.includes(LEAD_PHONE)), "notifications contain no name and no phone");

  console.log("## 7. failures: the API is down / the database is down");
  {
    const dbdown = await raw(API_DBDOWN.port, "/api/health", { host: API_DBDOWN.host });
    ok(dbdown.status >= 500, `API health reports the unreachable database (${dbdown.status})`);
    const d1 = await postJson(SITE_DOWN.port, SITE_DOWN.host, "/api/consent", { ...payload, idempotencyKey: crypto.randomUUID() });
    ok(d1.status >= 500 && d1.status < 600 && !/ECONNREFUSED|stack|postgres/i.test(d1.body), `site: consent while the database is down is refused cleanly (${d1.status}), no internals in the body`);
    const d2 = await postJson(SITE_DOWN.port, SITE_DOWN.host, "/api/lead", { ...leadBody, idempotencyKey: crypto.randomUUID() });
    ok(d2.status >= 500 && d2.status < 600, `site: an enquiry while the database is down is refused (${d2.status}), not sent anywhere else`);
    ok(!logs.get("site-down").join("").includes(LEAD_PHONE), "the failing site did not log the phone");
    children.get("api").kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    const d3 = await postJson(SITE.port, SITE.host, "/api/consent", { ...payload, idempotencyKey: crypto.randomUUID() });
    ok(d3.status >= 500 && d3.status < 600, `site: consent while the API process is down is refused (${d3.status})`);
    const home = await raw(SITE.port, "/", { host: SITE.host });
    ok(home.status === 200, "the public pages still open while the API is down");
  }

  console.log("## 8. the public texts describe the Kazakhstan scheme (build with NEXT_PUBLIC_SITE_PROFILE=kz-production)");
  {
    const pr = await raw(SITE.port, "/privacy", { host: SITE.host });
    const t = pr.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    ok(pr.status === 200 && t.includes("работают на сервере в Республике Казахстан") && t.includes("Қазақстан Республикасындағы серверде жұмыс істейді"), "/privacy describes storage and processing in Kazakhstan, RU and KK");
    ok(!/Vercel|Supabase|Франкфурт/.test(t), "/privacy no longer names the foreign processors");
    ok(/без имени и телефона/.test(t), "/privacy says Telegram receives no name and no phone");
    let chunk = "";
    try { chunk = execFileSync("grep", ["-rl", "уходит только уведомление без имени и телефона", ".next/static"], { cwd: repo, stdio: "pipe" }).toString(); } catch { /* not found */ }
    ok(chunk.length > 0, "the birthday form carries the Kazakhstan notice (Telegram: notification without name and phone)");
  }

  console.log("## 9. no personal data in the logs of any process");
  const all = [...logs.entries()].map(([k, v]) => [k, v.join("")]);
  const leaked = all.filter(([, t]) => t.includes(ADULT) || t.includes(LEAD_NAME) || t.includes(phoneDigits) || t.includes(LEAD_PHONE));
  ok(leaked.length === 0, `synthetic names and the phone appear in no process log (${leaked.map(([k]) => k).join(",") || "none"})`);
  ok(all.every(([, t]) => !t.includes(INTAKE) && !t.includes(CRON) && !t.includes(MFA_KEY) && !t.includes(ROLE_API_PW) && !t.includes(ROLE_ADMIN_PW)), "no secret appears in any log");
} finally {
  // cleanup of this run's synthetic rows only
  try {
    const c = await owner.connect();
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const regs = (await c.query("SELECT id, contact_id FROM bb.consent_registrations WHERE contact_id IN (SELECT id FROM bb.contacts WHERE name = $1)", [ADULT])).rows;
    const ids = regs.map((r) => r.id);
    await c.query("DELETE FROM bb.attendance_entries WHERE registration_id = ANY($1::uuid[]) OR registration_id IS NULL AND created_at > now() - interval '1 hour'", [ids]);
    await c.query("DELETE FROM bb.consent_events WHERE registration_id = ANY($1::uuid[])", [ids]);
    await c.query("DELETE FROM bb.consent_registrations WHERE id = ANY($1::uuid[])", [ids]);
    await c.query("COMMIT");
    c.release();
  } catch { /* the database is local and disposable */ }
  telegram.close();
  await browser.close().catch(() => {});
  stopAll();
  await owner.end().catch(() => {});
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
