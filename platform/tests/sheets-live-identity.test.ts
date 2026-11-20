import test from "node:test";
import assert from "node:assert/strict";
import { reviewSourceIdentity, stableSourceIdentity, sheetPayload, sheetRowFingerprint } from "../src/core/sheets-import/identity.ts";

const key = "test-only-hmac-key-that-is-at-least-thirty-two-bytes-long";
const fingerprintKey = "synthetic fingerprint hmac key with at least thirty two bytes";
const base = {
  date: "28.11.2026", time: "14:00", room: "Ice Room", client: "Синтетика", phone: "+7 700 000 00 01",
  child: "Ребёнок Тест", age: "8", package: "Magic", animator: "Тестовый аниматор", prepayment: "10 000", children: "по факту", adults: "по факту",
};

test("natural source identity survives sort/row movement and schedule edits", () => {
  const initial = stableSourceIdentity(base, key);
  const moved = stableSourceIdentity({ ...base, date: "29.11.2026", time: "15:30", room: "Magic Room" }, key);
  assert.equal(initial.kind, "natural");
  assert.equal(moved.kind, "natural");
  assert.equal(initial.sourceKey, moved.sourceKey);
  assert.equal(initial.sourceKey?.includes("70000000001"), false);
  assert.notEqual(sheetRowFingerprint(base, fingerprintKey), sheetRowFingerprint({ ...base, time: "15:30" }, fingerprintKey));
  assert.notEqual(sheetRowFingerprint(base, fingerprintKey), sheetRowFingerprint(base, `${fingerprintKey}!`));
});

test("an explicit source ID remains stable if contact or event values change", () => {
  const initial = stableSourceIdentity({ ...base, sourceId: "party-uuid-001" }, key);
  const edited = stableSourceIdentity({ ...base, sourceId: "party-uuid-001", phone: "+7 700 000 00 99", date: "01.12.2026" }, key);
  assert.equal(initial.sourceKey, edited.sourceKey);
  assert.equal(initial.kind, "explicit");
});

test("incomplete natural identity and too-short HMAC key fail closed", () => {
  assert.deepEqual(stableSourceIdentity({ ...base, phone: "" }, key), { sourceKey: null, kind: "unusable", reason: "stable_id_missing" });
  assert.throws(() => stableSourceIdentity(base, "short"), /sheets_sync_key_invalid/);
});

test("rows without a business identity get a stable review-only locator without storing their source ID", () => {
  const incomplete = { date: "28.11.2026", time: "14:00", sourceId: "source-private-id" };
  assert.equal(reviewSourceIdentity(incomplete, key), reviewSourceIdentity({ ...incomplete }, key));
  assert.notEqual(reviewSourceIdentity(incomplete, key), reviewSourceIdentity({ ...incomplete, time: "15:00" }, key));
  assert.equal("sourceId" in sheetPayload({ ...base, sourceId: "source-private-id" }), false);
});

test("fingerprint excludes volatile row identity but includes business edits", () => {
  const first = { ...base, sourceId: "one" };
  const reordered = { ...base, sourceId: "two" };
  assert.equal(sheetRowFingerprint(first, fingerprintKey), sheetRowFingerprint(reordered, fingerprintKey));
  assert.notEqual(sheetRowFingerprint(first, fingerprintKey), sheetRowFingerprint({ ...first, animator: "Другой синтетический аниматор" }, fingerprintKey));
});
