/** Unit tests for the analytics sanitiser. Run: npm run test:funnel */
import test from "node:test";
import assert from "node:assert/strict";
import { BIRTHDAY_EVENTS, cleanPath, createDeduper, errorTypeFromStatus, sanitizeBirthdayParams } from "../src/lib/funnel-core.ts";

const allowed = { packages: ["wow-party", "magic-party", "boom-party", "undecided"], rooms: ["roblox-room", "ice-room", "magic-room", "rapunzel-room"] };

test("the seven funnel events are exactly the agreed ones", () => {
  assert.deepEqual([...BIRTHDAY_EVENTS], ["birthday_package_select", "birthday_room_open", "birthday_room_select", "birthday_lead_form_open", "birthday_lead_submit_attempt", "birthday_lead_success", "birthday_lead_error"]);
});

test("only the five whitelisted keys survive; PII keys are dropped", () => {
  const out = sanitizeBirthdayParams({ package_id: "wow-party", room_id: "ice-room", cta_source: "room_dialog", page_path: "/birthdays", name: "Айгерим", phone: "+77071234567", date: "2026-12-05", children: "8", text: "hello", token: "123:SECRET" }, allowed);
  assert.deepEqual(Object.keys(out).sort(), ["cta_source", "error_type", "package_id", "page_path", "room_id"]);
  const blob = JSON.stringify(out);
  for (const bad of ["Айгерим", "7071234567", "2026-12-05", "SECRET", "hello"]) assert.ok(!blob.includes(bad), bad);
});

test("package and room ids are checked against the allowed lists", () => {
  assert.equal(sanitizeBirthdayParams({ package_id: "boom-party" }, allowed).package_id, "boom-party");
  assert.equal(sanitizeBirthdayParams({ package_id: "+77071234567" }, allowed).package_id, "unknown");
  assert.equal(sanitizeBirthdayParams({ room_id: "Иван Иванов" }, allowed).room_id, "unknown");
  assert.equal(sanitizeBirthdayParams({}, allowed).room_id, "none");
});

test("cta_source is normalised to a short safe token", () => {
  assert.equal(sanitizeBirthdayParams({ cta_source: "Sticky Bar!" }, allowed).cta_source, "sticky_bar");
  assert.equal(sanitizeBirthdayParams({ cta_source: "a".repeat(200) }, allowed).cta_source.length, 40);
  assert.equal(sanitizeBirthdayParams({ cta_source: "+7 707 123 45 67" }, allowed).cta_source, "7_707_123_45_67"); // digits only, never raw text with PII structure
});

test("page_path never carries a query string or fragment", () => {
  assert.equal(cleanPath("/birthdays?utm_source=ig&phone=7071234567#rooms"), "/birthdays");
  assert.equal(cleanPath("https://evil.example/x"), "/");
  assert.equal(cleanPath(undefined), "/");
});

test("error_type is limited to the known list", () => {
  assert.equal(sanitizeBirthdayParams({ error_type: "delivery_failed" }, allowed).error_type, "delivery_failed");
  assert.equal(sanitizeBirthdayParams({ error_type: "Не удалось: +7707" }, allowed).error_type, "other");
  assert.equal(sanitizeBirthdayParams({}, allowed).error_type, "none");
});

test("HTTP status maps to an error type", () => {
  assert.deepEqual([400, 403, 429, 502, 503, 500, 418].map(errorTypeFromStatus), ["validation_server", "forbidden", "rate_limited", "delivery_failed", "not_configured", "server_error", "other"]);
});

test("deduper drops an identical event inside the window and allows it after", () => {
  let t = 1000; const once = createDeduper(800, () => t);
  assert.equal(once("k"), true); t += 100; assert.equal(once("k"), false); t += 100; assert.equal(once("k"), false);
  t += 2000; assert.equal(once("k"), true); assert.equal(once("other"), true);
});
