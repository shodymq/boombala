/**
 * Calendar contract tests: strict parsing of FastAPI availability, customer-data stripping, fail-closed answers,
 * branch handling and source selection. No network.
 *
 *   npm run test:calendar
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityDayRoute,
  availabilityMonthRoute,
  createFastapiClient,
  FastapiError,
  getAvailabilityDay,
  getAvailabilityMonth,
  parseAvailabilityDay,
  parseAvailabilityMonth,
} from "../src/lib/fastapi/core.ts";
import { availabilitySource } from "../src/lib/availability/source.ts";

const CAL_ON = { FASTAPI_FEATURES: "calendar", FASTAPI_BASE_URL: "https://api-staging.example.kz/api/v1", FASTAPI_SITE_BRANCH_ID: "main" };

const DAY = {
  date: "2026-11-15",
  slots: [
    { id: 1, startsAt: "10:00", endsAt: "12:00", freeRoomIds: ["room-a", "room-b"] },
    { id: 2, startsAt: "14:00", endsAt: "16:00", freeRoomIds: [] },
  ],
  prices: {
    "wow-party": { amountKzt: 85000, source: "weekday" },
    "magic-party": null,
  },
};

// ── Parsing: same shape as the platform, nothing else gets through ───────────────────────────────

test("a valid day answer is accepted and equals the platform shape", () => {
  const out = parseAvailabilityDay(DAY);
  assert.deepEqual(out, DAY);
});

test("customer and contact fields are dropped, so they can never reach the browser", () => {
  const leaky = structuredClone(DAY) as Record<string, unknown>;
  (leaky.slots as Record<string, unknown>[])[0].customer = "Айжан Тестова";
  (leaky.slots as Record<string, unknown>[])[0].phone = "+77071234567";
  leaky.notes = "внутренняя заметка";
  const text = JSON.stringify(parseAvailabilityDay(leaky));
  assert.ok(!text.includes("Айжан"));
  assert.ok(!text.includes("77071234567"));
  assert.ok(!text.includes("внутренняя"));
});

test("a slot without freeRoomIds is an error, never 'free'", () => {
  const bad = structuredClone(DAY) as Record<string, unknown>;
  delete (bad.slots as Record<string, unknown>[])[0].freeRoomIds;
  assert.throws(() => parseAvailabilityDay(bad), (e: unknown) => e instanceof FastapiError && e.kind === "invalid_response");
});

test("prices must have a known source and a non-negative whole amount", () => {
  const badSource = structuredClone(DAY) as { prices: Record<string, unknown> };
  badSource.prices["wow-party"] = { amountKzt: 85000, source: "discount" };
  assert.throws(() => parseAvailabilityDay(badSource), FastapiError);
  const negative = structuredClone(DAY) as { prices: Record<string, unknown> };
  negative.prices["wow-party"] = { amountKzt: -1, source: "base" };
  assert.throws(() => parseAvailabilityDay(negative), FastapiError);
});

test("month: free rooms cannot exceed the room count, and keys must be well-formed", () => {
  const ok = { month: "2026-11", roomCount: 4, days: { "2026-11-15": { "1": 2, "2": 0 } } };
  assert.deepEqual(parseAvailabilityMonth(ok), ok);
  assert.throws(() => parseAvailabilityMonth({ ...ok, days: { "2026-11-15": { "1": 9 } } }), FastapiError);
  assert.throws(() => parseAvailabilityMonth({ ...ok, days: { "15-11-2026": { "1": 1 } } }), FastapiError);
  assert.throws(() => parseAvailabilityMonth({ ...ok, month: "2026-13" }), FastapiError);
});

// ── Routes: branch and date are validated before any call ─────────────────────────────────────────

test("route builders refuse malformed dates and unsafe branch ids", () => {
  assert.throws(() => availabilityDayRoute("2026-1-5", "main"), FastapiError);
  assert.throws(() => availabilityMonthRoute("2026-13", "main"), FastapiError);
  assert.throws(() => availabilityDayRoute("2026-11-15", "main&admin=1"), (e: unknown) => e instanceof FastapiError && e.kind === "not_configured");
  assert.equal(availabilityDayRoute("2026-11-15", "main"), "/public/availability?date=2026-11-15&branch_id=main");
  assert.equal(availabilityMonthRoute("2026-11", "main"), "/public/availability?month=2026-11&branch_id=main");
});

// ── Calls: an absent endpoint or a broken answer is an error, never a free calendar ──────────────

function stub(status: number, body: unknown) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const client = createFastapiClient({
    config: { baseUrl: "https://api-staging.example.kz/api/v1", timeoutMs: 1000, features: new Set(["calendar"]) },
    fetchImpl,
  });
  return { calls, client };
}

test("the day call goes to the branch-scoped route and returns the parsed day", async () => {
  const { calls, client } = stub(200, DAY);
  const out = await getAvailabilityDay(client, "2026-11-15", { branchId: "main" });
  assert.equal(out.slots[0].freeRoomIds.length, 2);
  assert.equal(calls[0], "https://api-staging.example.kz/api/v1/public/availability?date=2026-11-15&branch_id=main");
});

test("an absent FastAPI endpoint (404) is an error, not an empty or free calendar", async () => {
  const { client } = stub(404, { error: { code: "not_found", message: "x" } });
  await assert.rejects(getAvailabilityMonth(client, "2026-11", { branchId: "main" }), (e: unknown) => e instanceof FastapiError && e.kind === "rejected" && e.status === 404);
});

test("a 5xx from FastAPI is unavailable", async () => {
  const { client } = stub(500, { error: { code: "db", message: "x" } });
  await assert.rejects(getAvailabilityDay(client, "2026-11-15", { branchId: "main" }), (e: unknown) => e instanceof FastapiError && e.kind === "unavailable");
});

// ── Source selection ──────────────────────────────────────────────────────────────────────────────

test("without the calendar feature the platform stays the source (today's behaviour)", () => {
  assert.deepEqual(availabilitySource({}), { kind: "platform" });
  assert.deepEqual(availabilitySource({ FASTAPI_FEATURES: "leads,otp,account" }), { kind: "platform" });
});

test("calendar feature with a valid URL and branch selects FastAPI for that branch", () => {
  assert.deepEqual(availabilitySource(CAL_ON), { kind: "fastapi", branchId: "main" });
});

test("calendar feature without a branch, or with an unsafe URL, is unavailable — no silent fallback", () => {
  assert.deepEqual(availabilitySource({ ...CAL_ON, FASTAPI_SITE_BRANCH_ID: "" }), { kind: "unavailable", reason: "fastapi_misconfigured" });
  assert.deepEqual(availabilitySource({ ...CAL_ON, FASTAPI_BASE_URL: "http://api.example.kz" }), { kind: "unavailable", reason: "fastapi_misconfigured" });
  assert.deepEqual(availabilitySource({ ...CAL_ON, FASTAPI_SITE_BRANCH_ID: "main/../x" }), { kind: "unavailable", reason: "fastapi_misconfigured" });
});
