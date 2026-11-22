#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3300";
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54330/boombala_platform";
assert.match(BASE_URL, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const db = new URL(DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(db.hostname), "refusing non-local PostgreSQL");
assert.ok(Number(db.port) >= 1024 && Number(db.port) <= 65535, "test must use an explicit local PostgreSQL TCP port");
if (db.port !== "54330") assert.ok(process.env.TEST_DATABASE_URL, "non-default local test port requires explicit TEST_DATABASE_URL");

function psql(sql) {
  const r = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", DATABASE_URL, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("local database assertion failed");
  return r.stdout.trim();
}

const ids = ["happy-party", "star-party", "boom-bala-party", "wow-party", "magic-party", "boom-party"];
const keys = ids.map(() => randomUUID());
const baseCount = Number(psql("SELECT count(*) FROM bb.lead_requests"));
const outboxBefore = Number(psql("SELECT count(*) FROM bb.outbox WHERE topic='telegram.lead'"));

for (const [path, locale] of [["/birthdays", "RU"], ["/kk/birthdays", "KK"]]) {
  const response = await fetch(`${BASE_URL}${path}`);
  assert.equal(response.status, 200, `${locale} package page must load`);
  const html = await response.text();
  assert.ok(html.includes("HAPPY PARTY") && html.includes("STAR PARTY") && html.includes("BOOM BALA PARTY"), `${locale} page must render all three package names`);
  const visibleText = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&[^;]+;/g, " ").replace(/[\s\u00a0\u202f]+/g, "");
  for (const amount of ["54900", "38430", "79900", "55930", "114900", "80430"]) {
    assert.ok(visibleText.includes(amount), `${locale} page must render approved price ${amount}`);
  }
}

async function post(pkg, key, extra = {}) {
  const response = await fetch(`${BASE_URL}/api/lead`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Synthetic Release Test",
      phone: "+15555550100",
      date: "2099-12-22",
      children: "6",
      package: pkg,
      consent: true,
      room: "ice-room",
      slot: "2",
      idempotencyKey: key,
      page: "/birthdays",
      ...extra,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

for (let i = 0; i < ids.length; i++) {
  const result = await post(ids[i], keys[i]);
  assert.equal(result.status, 200, `submission failed for ${ids[i]}`);
  assert.equal(result.body.ok, true, `submission not acknowledged for ${ids[i]}`);
}

const repeated = await post(ids[0], keys[0]);
assert.equal(repeated.status, 200);
assert.equal(repeated.body.duplicate, true, "same idempotency key must return the committed request");
const invalid = await post("not-a-package", randomUUID());
assert.equal(invalid.status, 400, "unknown package must be rejected at the public site");

const saved = Number(psql(`SELECT count(*) FROM bb.lead_requests WHERE idempotency_key IN (${keys.map((k) => `'${k}'::uuid`).join(",")})`));
assert.equal(saved, ids.length, "all six distinct requests must be persisted exactly once");
const exactPackages = psql(`SELECT string_agg(package_id, ',' ORDER BY package_id) FROM bb.lead_requests WHERE idempotency_key IN (${keys.map((k) => `'${k}'::uuid`).join(",")})`);
assert.equal(exactPackages, [...ids].sort().join(","), "package IDs must be preserved exactly");
const exactSlots = Number(psql(`SELECT count(*) FROM bb.lead_requests WHERE idempotency_key IN (${keys.map((k) => `'${k}'::uuid`).join(",")}) AND slot_id=2`));
assert.equal(exactSlots, ids.length, "the existing slot field must be retained without time-contract translation");
const queued = Number(psql(`SELECT count(*) FROM bb.outbox WHERE topic='telegram.lead' AND ref_id IN (SELECT id FROM bb.lead_requests WHERE idempotency_key IN (${keys.map((k) => `'${k}'::uuid`).join(",")}))`));
assert.equal(queued, ids.length, "each newly committed request must have one outbox reference");
assert.equal(Number(psql("SELECT count(*) FROM bb.lead_requests")), baseCount + ids.length, "duplicate or invalid request created a row");
assert.equal(Number(psql("SELECT count(*) FROM bb.outbox WHERE topic='telegram.lead'")), outboxBefore + ids.length, "duplicate or invalid request queued an extra notification");

console.log("PASS: RU/KK package pages; strict site → Platform → local PostgreSQL; all 3 V4.2 and 3 legacy IDs; slot field; persistence; outbox; idempotency; invalid package rejected; no Telegram credentials");
