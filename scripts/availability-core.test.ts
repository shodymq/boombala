/**
 * Calendar contract tests against REAL FastAPI responses (scripts/fixtures/availability/*.json, captured from
 * BoomBalaApp codex/public-availability-v1 with its own test setup). No network.
 *
 *   npm run test:calendar
 *
 * The test vocabulary matches the fixture (2 rooms, 2 slots, 1 package). The production vocabulary is the site's
 * (4 rooms, 3 slots, 3 packages) and needs a real catalog map (blocker CATALOG-001).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createFastapiClient,
  FastapiError,
  getPublicAvailability,
  parsePublicAvailability,
  publicAvailabilityRoute,
  type PublicAvailabilityResponse,
} from "../src/lib/fastapi/core.ts";
import { adaptDay, adaptMonth, AvailabilityAdapterError, parseCatalogMap, type CatalogMap, type SiteVocabulary } from "../src/lib/availability/adapter.ts";
import { availabilitySource } from "../src/lib/availability/source.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): { status: number; body: unknown } =>
  JSON.parse(readFileSync(join(here, "fixtures", "availability", `${name}.json`), "utf8"));
const bodyOf = (name: string): PublicAvailabilityResponse => parsePublicAvailability(fixture(name).body);

const VOCAB: SiteVocabulary = { roomIds: ["ice-room", "magic-room"], slotIds: ["1", "2"], packageValues: ["wow-party"] };
const MAP: CatalogMap = {
  branchId: "branch-main",
  rooms: { "ice-room": "room-main-a", "magic-room": "room-main-b" },
  slots: { "1": "slot-morning", "2": "slot-evening" },
  packages: { "wow-party": "package-main" },
};
const DATE = "2099-05-15";

const adaptFail = (fn: () => unknown, kind: string) =>
  assert.throws(fn, (e: unknown) => e instanceof AvailabilityAdapterError && e.kind === kind, `expected ${kind}`);

// ── Real date response ─────────────────────────────────────────────────────────────────────────────

test("date: free and busy cells become the panel's free rooms per site slot, ids preserved", () => {
  const day = adaptDay(bodyOf("date_busy_and_free"), { branchId: "branch-main", date: DATE }, MAP, VOCAB);
  assert.equal(day.date, DATE);
  assert.deepEqual(day.slots, [
    { id: 1, startsAt: "10:00", endsAt: "14:00", freeRoomIds: ["magic-room"] },
    { id: 2, startsAt: "18:00", endsAt: "22:00", freeRoomIds: ["ice-room"] },
  ]);
});

test("date: a slot with no free room is busy (empty freeRoomIds), not hidden", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.availability = raw.availability.map((c) => ({ ...c, status: "busy" as const }));
  const day = adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB);
  assert.deepEqual(day.slots.map((s) => s.freeRoomIds), [[], []]);
});

test("date: price is the catalog base price with source base, and it is not invented", () => {
  const day = adaptDay(bodyOf("date_busy_and_free"), { branchId: "branch-main", date: DATE }, MAP, VOCAB);
  assert.deepEqual(day.prices, { "wow-party": { amountKzt: 55000, source: "base" } });
});

test("date: an unknown price is null, shown as unknown, never as a tariff", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.packages = [{ id: "package-main", name: "Party", priceKzt: null, priceSource: null }];
  assert.deepEqual(adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB).prices, { "wow-party": null });
  // a package the map does not know → unknown, not an error and not a guess
  const emptyMap = { ...MAP, packages: { "wow-party": "package-unknown" } };
  assert.deepEqual(adaptDay(bodyOf("date_busy_and_free"), { branchId: "branch-main", date: DATE }, emptyMap, VOCAB).prices, { "wow-party": null });
});

test("date: a price with an unknown origin is refused as malformed", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.packages[0].priceSource = "weekday_rule";
  adaptFail(() => adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB), "malformed");
});

// ── Real month response ────────────────────────────────────────────────────────────────────────────

test("month: every day of the month is present, with free counts per site slot", () => {
  const month = adaptMonth(bodyOf("month_full"), { branchId: "branch-main", month: "2099-05" }, MAP, VOCAB);
  assert.equal(month.roomCount, 2);
  assert.equal(Object.keys(month.days).length, 31);
  assert.deepEqual(month.days[DATE], { "1": 1, "2": 1 });
  assert.deepEqual(month.days["2099-05-01"], { "1": 2, "2": 2 });
});

test("month: the captured filtered response is NOT a full month and is refused, not read as free", () => {
  adaptFail(() => adaptMonth(bodyOf("month_filtered"), { branchId: "branch-main", month: "2099-05" }, MAP, VOCAB), "incomplete");
});

// ── Unavailable and malformed ─────────────────────────────────────────────────────────────────────

test("API unavailable: the real 503 envelope is an error with no data", async () => {
  const f = fixture("unconfigured_catalog");
  assert.equal(f.status, 503);
  const client = createFastapiClient({
    config: { baseUrl: "https://api.example.kz/api/v1", timeoutMs: 1000, features: new Set(["calendar"]) },
    fetchImpl: async () => new Response(JSON.stringify(f.body), { status: 503, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(getPublicAvailability(client, { branchId: "branch-main", date: DATE }), (e: unknown) => e instanceof FastapiError && e.kind === "unavailable");
});

test("branch not found (404) and past date (422) are errors, not data", async () => {
  for (const [name, status, kind] of [["date_unknown_branch", 404, "rejected"], ["date_past", 422, "rejected"]] as const) {
    const f = fixture(name);
    const client = createFastapiClient({
      config: { baseUrl: "https://api.example.kz/api/v1", timeoutMs: 1000, features: new Set(["calendar"]) },
      fetchImpl: async () => new Response(JSON.stringify(f.body), { status, headers: { "content-type": "application/json" } }),
    });
    await assert.rejects(getPublicAvailability(client, { branchId: "branch-main", date: DATE }), (e: unknown) => e instanceof FastapiError && e.kind === kind);
  }
});

test("malformed payloads are invalid_response: unknown cell status, missing arrays, bad date", () => {
  const good = fixture("date_busy_and_free").body as Record<string, unknown>;
  const withStatus = (status: string) => ({ ...good, availability: [{ date: DATE, roomId: "room-main-a", slotId: "slot-morning", status }] });
  assert.throws(() => parsePublicAvailability(withStatus("unavailable")), (e: unknown) => e instanceof FastapiError && e.kind === "invalid_response");
  assert.throws(() => parsePublicAvailability({ ...good, rooms: undefined }), FastapiError);
  assert.throws(() => parsePublicAvailability({ ...good, date: "15.05.2099" }), FastapiError);
  assert.throws(() => parsePublicAvailability(null), FastapiError);
});

// ── Branch and period checks ─────────────────────────────────────────────────────────────────────

test("branch mismatch: a response for another branch is refused", () => {
  const raw = bodyOf("date_busy_and_free");
  adaptFail(() => adaptDay({ ...raw, branchId: "branch-other" }, { branchId: "branch-main", date: DATE }, MAP, VOCAB), "branch_mismatch");
  adaptFail(() => adaptDay(raw, { branchId: "branch-other", date: DATE }, MAP, VOCAB), "branch_mismatch");
  adaptFail(() => adaptDay(raw, { branchId: "branch-main", date: DATE }, { ...MAP, branchId: "branch-other" }, VOCAB), "branch_mismatch");
});

test("period mismatch: a day answer is not used as a month and the reverse", () => {
  adaptFail(() => adaptDay(bodyOf("month_full"), { branchId: "branch-main", date: DATE }, MAP, VOCAB), "period_mismatch");
  adaptFail(() => adaptMonth(bodyOf("date_busy_and_free"), { branchId: "branch-main", month: "2099-05" }, MAP, VOCAB), "period_mismatch");
});

// ── No false free slots ──────────────────────────────────────────────────────────────────────────

test("a missing cell is incomplete, never free", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.availability = raw.availability.filter((c) => !(c.roomId === "room-main-b" && c.slotId === "slot-morning"));
  adaptFail(() => adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB), "incomplete");
});

test("a mapped slot missing from the answer is incomplete, not free", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.slots = raw.slots.filter((s) => s.id !== "slot-evening");
  adaptFail(() => adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB), "incomplete");
});

test("duplicate cells are malformed (two answers for one place)", () => {
  const raw = bodyOf("date_busy_and_free");
  raw.availability.push({ ...raw.availability[0], status: "free" });
  adaptFail(() => adaptDay(raw, { branchId: "branch-main", date: DATE }, MAP, VOCAB), "malformed");
});

test("a month missing a whole day is incomplete", () => {
  const raw = bodyOf("month_full");
  raw.availability = raw.availability.filter((c) => c.date !== "2099-05-20");
  adaptFail(() => adaptMonth(raw, { branchId: "branch-main", month: "2099-05" }, MAP, VOCAB), "incomplete");
});

// ── Privacy and ID mapping ───────────────────────────────────────────────────────────────────────

test("no customer PII: extra fields in the answer never reach the site output", () => {
  const raw = bodyOf("date_busy_and_free") as unknown as Record<string, unknown>;
  const leaky = JSON.parse(JSON.stringify(raw));
  leaky.availability[0].customer = "Айжан Тестова";
  leaky.availability[0].phone = "+77071234567";
  leaky.slots[0].note = "внутренняя заметка";
  leaky.packages[0].contact = "+77070000000";
  const out = adaptDay(parsePublicAvailability(leaky), { branchId: "branch-main", date: DATE }, MAP, VOCAB);
  const text = JSON.stringify(out);
  for (const secret of ["Айжан", "77071234567", "внутренняя", "77070000000", "reservation", "customer"]) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
});

test("ID mapping is preserved: site ids and site room ids come out, backend ids do not", () => {
  const text = JSON.stringify(adaptDay(bodyOf("date_busy_and_free"), { branchId: "branch-main", date: DATE }, MAP, VOCAB));
  assert.ok(!text.includes("slot-morning") && !text.includes("room-main-a") && !text.includes("package-main"));
  assert.ok(text.includes('"freeRoomIds":["magic-room"]'));
});

test("catalog map must be complete and one-to-one", () => {
  const ok = JSON.stringify(MAP);
  assert.deepEqual(parseCatalogMap(ok, VOCAB), MAP);
  const incomplete = JSON.stringify({ ...MAP, slots: { "1": "slot-morning" } });
  const shared = JSON.stringify({ ...MAP, rooms: { "ice-room": "room-main-a", "magic-room": "room-main-a" } });
  const extra = JSON.stringify({ ...MAP, rooms: { ...MAP.rooms, "ghost-room": "room-x" } });
  for (const bad of [undefined, "", "not json", incomplete, shared, extra]) {
    assert.throws(() => parseCatalogMap(bad, VOCAB), (e: unknown) => e instanceof AvailabilityAdapterError && e.kind === "catalog_map_invalid");
  }
});

// ── Request contract ─────────────────────────────────────────────────────────────────────────────

test("request uses the real parameter names: branchId plus exactly one of date or month", () => {
  assert.equal(publicAvailabilityRoute({ branchId: "branch-main", date: DATE }), `/public/availability?branchId=branch-main&date=${DATE}`);
  assert.equal(publicAvailabilityRoute({ branchId: "branch-main", month: "2099-05" }), "/public/availability?branchId=branch-main&month=2099-05");
  assert.throws(() => publicAvailabilityRoute({ branchId: "main&admin=1", date: DATE }), FastapiError);
  assert.throws(() => publicAvailabilityRoute({ branchId: "branch-main", date: "2099-5-1" }), FastapiError);
});

test("source: calendar on needs a valid catalog map, otherwise unavailable; calendar off stays on the platform", () => {
  const base = { FASTAPI_FEATURES: "calendar", FASTAPI_BASE_URL: "https://api.example.kz/api/v1" };
  assert.deepEqual(availabilitySource({}, VOCAB), { kind: "platform" });
  assert.equal(availabilitySource({ ...base, FASTAPI_CATALOG_MAP: JSON.stringify(MAP) }, VOCAB).kind, "fastapi");
  assert.deepEqual(availabilitySource(base, VOCAB), { kind: "unavailable", reason: "fastapi_misconfigured" });
  assert.deepEqual(availabilitySource({ ...base, FASTAPI_BASE_URL: "http://x.kz", FASTAPI_CATALOG_MAP: JSON.stringify(MAP) }, VOCAB), {
    kind: "unavailable",
    reason: "fastapi_misconfigured",
  });
});
