/**
 * End-to-end check of POST /api/lead against a MOCK Telegram server (nothing reaches the real group).
 *
 *   TELEGRAM_BOT_TOKEN=000:test TELEGRAM_CHAT_ID=-1 TELEGRAM_API_BASE=http://localhost:4010 npm run dev
 *   npm run test:lead-api            # in another terminal
 *
 * Run it against `npm run dev` (the lead rate limit is 60 per 10 min there; production allows only 5,
 * which this suite would exceed by design).
 *
 * Safety: every test lead is named "ТЕСТ — НЕ ОБРАБАТЫВАТЬ" and the script only talks to localhost.
 * The mock listens on :4010 and fails on purpose for leads whose name contains FAIL-TELEGRAM.
 */
import http from "node:http";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server: " + BASE);
const NAME = "ТЕСТ — НЕ ОБРАБАТЫВАТЬ";

const received = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let text = "";
    try { text = JSON.parse(body).text ?? ""; } catch {}
    res.setHeader("content-type", "application/json");
    if (text.includes("HANG-TELEGRAM")) return; // never answers: simulates a Telegram timeout
    if (text.includes("FAIL-TELEGRAM")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
      return;
    }
    received.push(text);
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => mock.listen(4010, r));

const base = { name: NAME, phone: "+77071234567", date: "2026-12-05", package: "wow-party", consent: true, children: "8", page: "/birthdays" };
let n = 0;
const RUNIP = `192.0.2.${1 + Math.floor(Math.random() * 250)}`; // own IP per run, so the per-IP limit never leaks between runs
const RUN = Math.floor(Math.random() * 8000000); // random per run: re-running within 90 s must not hit the duplicate guard
const post = async (over, headers = {}) => {
  const body = { ...base, phone: `+7707${String(1000000 + RUN + ++n).slice(-7)}`, ...over };
  const res = await fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": RUNIP, ...headers }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  await new Promise((r) => setTimeout(r, 120));
  return { status: res.status, json, body };
};
const line = (text, label) => (text.split("\n").find((l) => l.startsWith(label)) ?? "").slice(label.length).trim();

let passed = 0;
const check = async (title, fn) => {
  const before = received.length;
  try { await fn(received, before); passed++; console.log("  ok  ", title); }
  catch (e) { console.log("  FAIL", title, "\n      ", e.message); process.exitCode = 1; }
};

console.log(`Server: ${BASE} | mock Telegram: :4010 | test lead name: "${NAME}"\n`);

await check("A. WOW PARTY + Roblox Room -> message has package, room, phone, date, children, name", async (r, b) => {
  const out = await post({ package: "wow-party", room: "roblox-room" });
  assert.equal(out.status, 200); assert.equal(out.json.ok, true);
  assert.equal(r.length, b + 1);
  const t = r[b];
  assert.equal(line(t, "Пакет:"), "WOW PARTY");
  assert.equal(line(t, "Предпочитаемая комната:"), "Roblox Room");
  assert.match(line(t, "Телефон:"), /^\+7 707 \d{3} \d{2} \d{2}$/);
  assert.equal(line(t, "Дата:"), "05.12.2026");
  assert.equal(line(t, "Детей:"), "8");
  assert.equal(line(t, "Имя:"), NAME);
  assert.ok(t.includes("Согласие на обработку данных: да"));
  assert.ok(!/undefined|null/.test(t), "message must not contain undefined/null");
});

await check("B. BOOM PARTY + Rapunzel Room", async (r, b) => {
  const out = await post({ package: "boom-party", room: "rapunzel-room" });
  assert.equal(out.status, 200); assert.equal(r.length, b + 1);
  assert.equal(line(r[b], "Пакет:"), "BOOM PARTY");
  assert.equal(line(r[b], "Предпочитаемая комната:"), "Rapunzel Room");
});

await check("C. no room (empty and absent) -> sent, room line is a dash; old clients still work", async (r, b) => {
  const a = await post({ room: "" }); const legacy = await post({ room: undefined });
  assert.equal(a.status, 200); assert.equal(legacy.status, 200); assert.equal(r.length, b + 2);
  assert.equal(line(r[b], "Предпочитаемая комната:"), "—"); assert.equal(line(r[b + 1], "Предпочитаемая комната:"), "—");
});

await check("D. the same room with a different package -> each lead keeps its own room and package", async (r, b) => {
  await post({ package: "wow-party", room: "ice-room", date: "2026-12-06" }); await post({ package: "boom-party", room: "ice-room", date: "2026-12-07" });
  assert.equal(r.length, b + 2);
  assert.deepEqual([line(r[b], "Пакет:"), line(r[b], "Предпочитаемая комната:")], ["WOW PARTY", "Ice Room"]);
  assert.deepEqual([line(r[b + 1], "Пакет:"), line(r[b + 1], "Предпочитаемая комната:")], ["BOOM PARTY", "Ice Room"]);
});

await check("E. invalid room id (unknown string, markup, number, array, object) -> 400, nothing sent", async (r, b) => {
  for (const room of ["hacked-room", "<b>x</b>", "ROBLOX-ROOM", 123, ["ice-room"], { id: "ice-room" }]) {
    const out = await post({ room });
    assert.equal(out.status, 400, JSON.stringify(room)); assert.ok(out.json.fieldErrors?.room, JSON.stringify(room));
  }
  assert.equal(r.length, b, "no Telegram message may be sent for an invalid room");
});

await check("F. Telegram rejects the lead -> API 502, no success flag", async (r, b) => {
  const out = await post({ name: `${NAME} FAIL-TELEGRAM` });
  assert.equal(out.status, 502); assert.notEqual(out.json.ok, true); assert.equal(out.json.error, "delivery_failed");
  assert.equal(r.length, b);
  assert.ok(!JSON.stringify(out.json).match(/chat not found|token|bot\d/i), "no Telegram details may leak to the client");
});

await check("consent is mandatory (missing and false) -> 400", async (r, b) => {
  assert.equal((await post({ consent: false })).status, 400); assert.equal((await post({ consent: undefined })).status, 400); assert.equal(r.length, b);
});

await check("phone: only +7 and 10 digits are accepted", async (r, b) => {
  assert.equal((await post({ phone: "+7707123" })).status, 400);
  assert.equal((await post({ phone: "abcdefghijk" })).status, 400);
  assert.equal(r.length, b);
});

await check("dates: past dates and non-dates are rejected", async () => {
  assert.equal((await post({ date: "2020-01-01" })).status, 400); assert.equal((await post({ date: "not-a-date" })).status, 400);
});

await check("honeypot -> 403, nothing sent", async (r, b) => {
  const out = await post({ website: "http://spam" }); assert.equal(out.status, 403); assert.equal(r.length, b);
});

await check("foreign Origin -> 403, nothing sent", async (r, b) => {
  const out = await post({}, { origin: "https://evil.example" }); assert.equal(out.status, 403); assert.equal(r.length, b);
});

await check("double submit of the same lead within seconds -> one Telegram message", async (r, b) => {
  const fixed = { phone: `+7707999${String(RUN).slice(-4)}`, date: "2026-12-20", package: "magic-party", room: "magic-room" };
  const first = await fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": RUNIP }, body: JSON.stringify({ ...base, ...fixed }) });
  const second = await fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": RUNIP }, body: JSON.stringify({ ...base, ...fixed }) });
  const j2 = await second.json(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(j2.duplicate, true);
  assert.equal(r.length, b + 1);
});

await check("G. delivery failed -> the parent's retry of the SAME lead is delivered (not swallowed as a duplicate)", async (r, b) => {
  const same = { phone: `+7707888${String(RUN).slice(-4)}`, date: "2026-12-21", package: "wow-party", room: "ice-room" };
  const failed = await post({ ...same, name: `${NAME} FAIL-TELEGRAM` });
  assert.equal(failed.status, 502);
  const retry = await post({ ...same });
  assert.equal(retry.status, 200); assert.equal(retry.json.ok, true);
  assert.notEqual(retry.json.duplicate, true, "a lead that was never delivered must not be reported as a duplicate");
  assert.equal(r.length, b + 1, "the retry must reach Telegram");
});

await check("H. two identical submissions at the same moment -> one message, both answered ok", async (r, b) => {
  const same = { ...base, phone: `+7707889${String(RUN).slice(-4)}`, date: "2026-12-22", package: "boom-party", room: "magic-room" };
  const go = () => fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": RUNIP }, body: JSON.stringify(same) });
  const [x, y] = await Promise.all([go(), go()]); await new Promise((r) => setTimeout(r, 200));
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  assert.equal(r.length, b + 1);
});

await check("I. invalid and undeliverable submissions do not use up the visitor's rate limit", async (r, b) => {
  for (let i = 0; i < 65; i++) await fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": RUNIP }, body: JSON.stringify({ ...base, consent: false }) });
  for (let i = 0; i < 65; i++) await post({ name: `${NAME} FAIL-TELEGRAM` });
  const ok = await post({});
  assert.equal(ok.status, 200, "a real parent must still get through after many invalid/failed attempts");
  assert.equal(r.length, b + 1);
});

await check("J. Telegram timeout (no answer) -> 502 within ~20 s, then the retry of the same lead is delivered", async (r, b) => {
  const same = { phone: `+7707887${String(RUN).slice(-4)}`, date: "2026-12-23", package: "magic-party", room: "rapunzel-room" };
  const t0 = Date.now();
  const hung = await post({ ...same, name: `${NAME} HANG-TELEGRAM` });
  const took = (Date.now() - t0) / 1000;
  assert.equal(hung.status, 502); assert.ok(took < 25, `took ${took}s`);
  const retry = await post({ ...same });
  assert.equal(retry.status, 200); assert.notEqual(retry.json.duplicate, true); assert.equal(r.length, b + 1);
  console.log(`        (timeout answered after ${took.toFixed(1)} s)`);
});

await check("L. 29th and 30th delivered leads from one IP pass, the 31st gets 429 + Retry-After; failures do not count", async (r, b) => {
  const ip = { "x-forwarded-for": "203.0.113." + (1 + Math.floor(Math.random() * 250)) };
  const nth = [];
  for (let i = 1; i <= 31; i++) {
    if (i === 10 || i === 20) { // an undeliverable lead in between must not consume the limit
      const bad = await post({ name: `${NAME} FAIL-TELEGRAM` }, ip); assert.equal(bad.status, 502);
    }
    nth.push((await post({}, ip)).status);
  }
  assert.deepEqual(nth.slice(0, 30).filter((x) => x !== 200), [], "leads 1-30 must all be delivered");
  assert.equal(nth[28], 200, "29th"); assert.equal(nth[29], 200, "30th"); assert.equal(nth[30], 429, "31st");
  const res = await fetch(BASE + "/api/lead", { method: "POST", headers: { "content-type": "application/json", ...ip }, body: JSON.stringify({ ...base, phone: `+7707555${String(RUN).slice(-4)}` }) });
  assert.equal(res.status, 429); assert.ok(Number(res.headers.get("retry-after")) > 0 && Number(res.headers.get("retry-after")) <= 600);
  assert.equal((await res.json()).error, "rate_limited");
  assert.equal(r.length, b + 30, "exactly 30 messages were delivered");
  // another visitor (another IP) is not affected
  assert.equal((await post({}, { "x-forwarded-for": "198.51.100.9" })).status, 200);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
console.log("\nExample message received by the mock (first lead):\n" + "-".repeat(40) + "\n" + received[0] + "\n" + "-".repeat(40));
mock.closeAllConnections?.();
mock.close();
