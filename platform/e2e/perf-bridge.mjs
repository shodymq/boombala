// Authenticated browser performance of the CRM in production-like bridge mode (local, synthetic data).
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/<db with migrations, seed, users owner@perf.test / manager@perf.test>
//   PERF_PASSWORD=<their password> [PERF_RTT_MS=40] [PERF_RUNS=7] [PERF_OUT=/path/result.json] node e2e/perf-bridge.mjs
//
// Topology (like production): a BRIDGE process ("VPS") that owns DATABASE_URL, a FRONTEND process ("Vercel") with
// CRM_BRIDGE_MODE=legacy and NO database variable, and a logging proxy between them that adds PERF_RTT_MS of round-trip delay
// to every bridge call (the real Vercel-region -> VPS latency cannot be reproduced locally; it is a parameter, not a guess).
// For every page it reports the number of bridge RPCs, each RPC's duration and the browser-side timings.
// The processes run with VERCEL_ENV=preview so the kz-production profile gate (a cheap per-request check) does not demand TLS,
// hosts and MFA; sessions, RBAC and the bridge token are unchanged. Needs a production build (`npm run build`) first. Only counts and durations are recorded; no tokens, bodies or personal data.
import { chromium } from "playwright-core";
import pg from "pg";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DATABASE_URL;
const PW = process.env.PERF_PASSWORD;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
if (!PW) throw new Error("PERF_PASSWORD is required");
const RTT = Number(process.env.PERF_RTT_MS ?? 40);
const RUNS = Number(process.env.PERF_RUNS ?? 7);
const OUT = process.env.PERF_OUT;
const TOKEN = randomBytes(24).toString("hex");
const P = { front: 3410, bridge: 3411, proxy: 3412 };

// ── logging proxy ────────────────────────────────────────────────────────────────────────────────────────────────────
let current = { name: "(idle)", calls: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proxy = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let op = req.url.replace(/^\/api\/bridge\//, "");
  if (op === "rpc") {
    try {
      op = `rpc:${JSON.parse(body.toString()).op}`;
    } catch {
      /* keep path */
    }
  }
  const started = performance.now();
  if (RTT) await sleep(RTT / 2);
  const up = httpRequest({ host: "127.0.0.1", port: P.bridge, path: req.url, method: req.method, headers: req.headers }, async (r) => {
    const out = [];
    for await (const c of r) out.push(c);
    if (RTT) await sleep(RTT / 2);
    const timing = r.headers["server-timing"] ?? "";
    const num = (k) => Number(new RegExp(`${k};dur=([0-9.]+)`).exec(timing)?.[1] ?? NaN);
    const queries = Number(/(\d+) queries/.exec(timing)?.[1] ?? NaN);
    current.calls.push({ op, ms: performance.now() - started, status: r.statusCode, serverMs: num("handler"), sessionMs: num("session"), dbMs: num("db"), queries, at: started, wall: Date.now() - (performance.now() - started) });
    res.writeHead(r.statusCode, r.headers);
    res.end(Buffer.concat(out));
  });
  up.on("error", () => {
    res.writeHead(502);
    res.end();
  });
  up.end(body);
});
await new Promise((r) => proxy.listen(P.proxy, "127.0.0.1", r));

// ── the two application processes ────────────────────────────────────────────────────────────────────────────────────
const children = [];
function start(name, port, env) {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env: { ...process.env, VERCEL_ENV: "preview", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.PERF_VERBOSE && process.stderr.write(`[${name}] ${d}`));
}
const clean = { ...process.env };
delete clean.DATABASE_URL;
start("bridge", P.bridge, { DATABASE_URL: DB, CRM_SERVICE_TOKEN: TOKEN, CRM_PERF_LOG: "1", DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "5", PLATFORM_ROLE: "admin" });
start("front", P.front, { CRM_BRIDGE_MODE: "legacy", CRM_BRIDGE_URL: `http://127.0.0.1:${P.proxy}`, CRM_SERVICE_TOKEN: TOKEN, UNIFIED_FASTAPI_CRM_ENABLED: "1", DATABASE_URL: "" });
for (const port of [P.bridge, P.front]) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" });
      break;
    } catch {
      await sleep(500);
    }
  }
}

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const FRONT = `http://127.0.0.1:${P.front}`;

async function login(email) {
  await page.goto(`${FRONT}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
}
await login("owner@perf.test");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : NaN;
};

const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const leadId = (await (await fetch(`${FRONT}/requests`, { headers: { cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).text()).match(/\/requests\/([0-9a-f-]{36})/)?.[1];
const ROUTES = [
  { name: "overview", path: "/", nav: 'a[href="/"]', ready: "main" },
  { name: "calendar", path: `/bookings?date=${today}`, nav: 'a[href="/bookings"]', ready: '[data-summary-counts]' },
  { name: "requests", path: "/requests", nav: 'a[href="/requests"]', ready: ".crm-requests-count" },
  { name: "requests-search", path: "/requests?status=new&q=%D0%93%D0%BE%D1%81%D1%82%D1%8C+12", ready: ".crm-requests-count" },
  { name: "request-card", path: `/requests/${leadId}`, ready: "#req-info" },
  { name: "attendance", path: "/attendance", nav: 'a[href="/attendance"]', ready: "main" },
  { name: "contacts", path: "/contacts", nav: 'a[href="/contacts"]', ready: "main" },
  { name: "audit", path: "/audit", nav: 'a[href="/audit"]', ready: "main" },
];

const results = [];
for (const route of ROUTES) {
  const hard = [];
  const soft = [];
  const feedbackMs = [];
  const rpcs = [];
  for (let i = 0; i < RUNS + 1; i++) {
    // Full document load (TTFB = time to the first byte of the HTML as the browser sees it).
    current = { name: `${route.name}#hard${i}`, calls: [] };
    await page.goto(`${FRONT}/`, { waitUntil: "load" });
    current = { name: `${route.name}#hard${i}`, calls: [] };
    await page.goto(`${FRONT}${route.path}`, { waitUntil: "load" });
    await page.waitForSelector(route.ready, { timeout: 20000 });
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd };
    });
    const hardCalls = current.calls;
    if (i > 0) hard.push({ ...nav, rpcCount: hardCalls.length, rpcMs: hardCalls.map((c) => c.ms), calls: hardCalls });
    // Client-side navigation from the overview (what a user does by clicking the sidebar), measured to "content ready".
    if (route.nav) {
      await page.goto(`${FRONT}/`, { waitUntil: "load" });
      await page.waitForTimeout(200);
      current = { name: `${route.name}#soft${i}`, calls: [] };
      const t0 = await page.evaluate(() => performance.now());
      const wall0 = Date.now();
      // Feedback: how soon the clicked link shows it is being opened (the pending marker, no data needed).
      const feedback = page.waitForSelector('.snow-nav-pending[data-pending="true"]', { state: "attached", timeout: 4000 }).then(() => Date.now() - wall0).catch(() => null);
      await page.click(`.snow-nav ${route.nav}`);
      await page.waitForSelector(route.ready, { timeout: 20000 });
      feedbackMs.push(await feedback);
      await page.waitForFunction((p) => location.pathname + location.search === p || location.pathname === p.split("?")[0], route.path);
      const t1 = await page.evaluate(() => performance.now());
      if (i > 0) soft.push({ ms: t1 - t0, calls: current.calls.length });
      if (process.env.PERF_TRACE && i === 1) {
        const res = await page.evaluate((t) => performance.getEntriesByType("resource").filter((e) => e.startTime >= t - 5).map((e) => `${e.name.replace(location.origin, "").slice(0, 70)} +${(e.startTime - t).toFixed(0)}..+${(e.responseEnd - t).toFixed(0)} (ttfb +${(e.responseStart - t).toFixed(0)})`), t0);
        console.log(`RES ${route.name}:`, res.join(" | "));
      }
      if (process.env.PERF_TRACE && i === 1) console.log(`TRACE ${route.name} soft nav ${(t1 - t0).toFixed(0)}ms:`, current.calls.map((c) => `${c.op} +${(c.wall - wall0).toFixed(0)}..+${(c.wall - wall0 + c.ms).toFixed(0)}`).join(" | "));
      if (i === 1) rpcs.push(...current.calls);
    }
  }
  results.push({
    route: route.name,
    hardTtfbMs: median(hard.map((h) => h.ttfb)),
    hardLoadMs: median(hard.map((h) => h.load)),
    hardLoadP95Ms: p95(hard.map((h) => h.load)),
    rpcPerPage: median(hard.map((h) => h.rpcCount)),
    softNavMs: soft.length ? median(soft.map((s) => s.ms)) : null,
    softNavP95Ms: soft.length ? p95(soft.map((s) => s.ms)) : null,
    clickFeedbackMs: feedbackMs.filter((x) => x !== null).length ? median(feedbackMs.filter((x) => x !== null)) : null,
    rpcs: hard[hard.length - 1].calls.map((c) => ({ op: c.op, rttMs: +c.ms.toFixed(1), serverMs: c.serverMs, sessionMs: c.sessionMs, dbMs: c.dbMs, queries: c.queries })),
  });
}

// Correctness of what the optimized pages show, against the database (the speed must not come from showing less).
const db = new pg.Client({ connectionString: DB });
await db.connect();
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const day = today;
await page.goto(`${FRONT}/bookings?date=${day}`);
await page.waitForSelector("[data-summary-counts]");
const summary = await page.locator("[data-summary-counts]").innerText();
const booked = Number((await db.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE released_at IS NULL AND kind='booking' AND slot_date=$1", [day])).rows[0].n);
const shown = Number(/(\d+)\s+(бронь|брони|броней)/.exec(summary)?.[1] ?? -1);
check("calendar shows the real number of bookings of the day", shown === booked, `page=${shown} db=${booked}`);
const openCount = Number((await db.query("SELECT count(*)::int n FROM bb.lead_requests WHERE requested_date=$1 AND status IN ('new','in_progress')", [day])).rows[0].n);
const shownOpen = Number(/(\d+)\+?\s+заяв/.exec(summary)?.[1] ?? 0);
check("calendar shows the real number of open requests of the day", shownOpen === openCount, `page=${shownOpen} db=${openCount}`);
await page.goto(`${FRONT}/requests`);
await page.waitForSelector(".crm-requests-count");
const total = Number((await page.locator(".crm-requests-count strong").innerText()).replace(/\D/g, ""));
const leadTotal = Number((await db.query("SELECT count(*)::int n FROM bb.lead_requests")).rows[0].n);
check("requests page shows the real total", total === leadTotal, `page=${total} db=${leadTotal}`);
await page.goto(`${FRONT}/requests/${leadId}`);
await page.waitForSelector("#req-info");
const cardName = (await db.query("SELECT c.name FROM bb.lead_requests l JOIN bb.contacts c ON c.id=l.contact_id WHERE l.id=$1", [leadId])).rows[0].name;
check("request card shows the record opened by id", (await page.locator("h1").first().innerText()).includes(cardName));
const unknown = await page.goto(`${FRONT}/requests/00000000-0000-4000-8000-000000000000`);
check("unknown request id answers 404", unknown?.status() === 404, `status=${unknown?.status()}`);
await db.end();

const f = (n) => (n === null || Number.isNaN(n) ? "-" : n.toFixed(0));
console.log(`\nPERF  rtt=${RTT}ms  runs=${RUNS}  (medians, ms)`);
console.log("route".padEnd(16) + "ttfb".padStart(7) + "load".padStart(7) + "load95".padStart(8) + "nav".padStart(7) + "nav95".padStart(7) + "  click".padStart(8) + "  rpc");
for (const r of results) console.log(r.route.padEnd(16) + f(r.hardTtfbMs).padStart(7) + f(r.hardLoadMs).padStart(7) + f(r.hardLoadP95Ms).padStart(8) + f(r.softNavMs).padStart(7) + f(r.softNavP95Ms).padStart(7) + f(r.clickFeedbackMs).padStart(8) + `  ${r.rpcPerPage}`);
console.log("\nbridge calls of one full load:");
for (const r of results) {
  console.log(`  ${r.route}`);
  for (const c of r.rpcs) console.log(`    ${c.op.padEnd(22)} rtt=${String(c.rttMs).padStart(6)}  handler=${f(c.serverMs).padStart(4)}  session=${f(c.sessionMs).padStart(3)}  sql=${f(c.dbMs).padStart(4)} (${c.queries} q)`);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ rtt: RTT, runs: RUNS, results }, null, 2));

await browser.close();
proxy.close();
if (failures.length) {
  for (const c of children) c.kill("SIGTERM");
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
for (const c of children) c.kill("SIGTERM");
process.exit(0);
