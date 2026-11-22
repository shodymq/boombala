#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const SQL = `${ROOT}deploy/kz/pricing-v42-catalog-add.sql`;
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54330/boombala_platform";
const TARGETS = [
  { id: "happy-party", name: "HAPPY PARTY", base: 54900, weekday: 38430 },
  { id: "star-party", name: "STAR PARTY", base: 79900, weekday: 55930 },
  { id: "boom-bala-party", name: "BOOM BALA PARTY", base: 114900, weekday: 80430 },
];
const manifest = JSON.parse(readFileSync(`${ROOT}src/data/birthday-packages-v4.json`, "utf8"));
const mapping = readFileSync(`${ROOT}src/data/birthdays-v4.ts`, "utf8");
const leadModel = readFileSync(`${ROOT}src/lib/lead.ts`, "utf8");
const leadForm = readFileSync(`${ROOT}src/components/lead/LeadForm.tsx`, "utf8");
const leadRoute = readFileSync(`${ROOT}src/app/api/lead/route.ts`, "utf8");
assert.deepEqual(Object.keys(manifest.locales.ru).sort(), ["boom", "happy", "star"]);
assert.deepEqual(Object.keys(manifest.locales.kz).sort(), ["boom", "happy", "star"]);
assert.deepEqual(
  [manifest.packages.happy.weekend, manifest.packages.happy.weekday, manifest.packages.star.weekend, manifest.packages.star.weekday, manifest.packages.boom.weekend, manifest.packages.boom.weekday],
  [54900, 38430, 79900, 55930, 114900, 80430],
);
for (const [locale, key, name] of [["ru", "happy", "HAPPY PARTY"], ["ru", "star", "STAR PARTY"], ["ru", "boom", "BOOM BALA PARTY"], ["kz", "happy", "HAPPY PARTY"], ["kz", "star", "STAR PARTY"], ["kz", "boom", "BOOM BALA PARTY"]]) {
  assert.equal(manifest.locales[locale][key].name, name);
}
for (const target of TARGETS) {
  assert.ok(mapping.includes(`"${target.id}"`), `missing public ID mapping ${target.id}`);
}
assert.match(leadModel, /birthdayPackagesV4/);
assert.match(leadModel, /PUBLIC_PACKAGE_OPTIONS/);
assert.match(leadForm, /PUBLIC_PACKAGE_OPTIONS/);
assert.doesNotMatch(leadForm, /preferredStartTime/);
assert.doesNotMatch(leadRoute, /preferredStartTime/);
const legacyCatalog = readFileSync(`${ROOT}src/data/birthdays.ts`, "utf8");
assert.match(legacyCatalog, /"wow-party"|wow-party/);
assert.match(legacyCatalog, /"magic-party"|magic-party/);
assert.match(legacyCatalog, /"boom-party"|boom-party/);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${result.status ?? result.signal})`);
  return result.stdout.trim();
}

const url = new URL(DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname), "refusing non-local PostgreSQL");
assert.ok(Number(url.port) >= 1024 && Number(url.port) <= 65535, "test must use an explicit local PostgreSQL TCP port");
if (url.port !== "54330") assert.ok(process.env.TEST_DATABASE_URL, "non-default local test port requires explicit TEST_DATABASE_URL");
assert.equal(url.pathname, "/boombala_platform", "unexpected test database name");

function psql(sql) {
  return run("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", DATABASE_URL, "-c", sql]);
}

function snapshot() {
  return psql(`
    SELECT json_build_object(
      'legacy_packages', (SELECT json_agg(row_to_json(x) ORDER BY x.id) FROM (SELECT id,name,sort_order,is_active FROM bb.packages WHERE id NOT IN ('happy-party','star-party','boom-bala-party')) x),
      'legacy_prices', (SELECT json_agg(row_to_json(x) ORDER BY x.id) FROM (SELECT id,package_id,rule_type,rule_date,amount_kzt,note FROM bb.price_rules WHERE package_id NOT IN ('happy-party','star-party','boom-bala-party')) x),
      'contacts', (SELECT count(*) FROM bb.contacts),
      'leads', (SELECT count(*) FROM bb.lead_requests),
      'reservations', (SELECT count(*) FROM bb.slot_reservations),
      'payment_facts', (SELECT count(*) FROM bb.manual_payment_facts)
    )::text
  `);
}

assert.equal(psql("SELECT to_regclass('bb.packages') IS NOT NULL AND to_regclass('bb.price_rules') IS NOT NULL"), "t", "apply Platform migrations first");
const before = snapshot();
const initiallyPresent = psql("SELECT count(*)::text FROM bb.packages WHERE id IN ('happy-party','star-party','boom-bala-party')");
assert.equal(initiallyPresent, "0", "use a freshly migrated database seeded with the legacy catalogue to prove first insert");

run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", DATABASE_URL, "-f", SQL]);
const first = psql(`
  SELECT json_agg(json_build_object(
    'id', p.id, 'name', p.name, 'active', p.is_active,
    'base', (SELECT amount_kzt FROM bb.price_rules r WHERE r.package_id=p.id AND r.rule_type='base' AND rule_date IS NULL ORDER BY id DESC LIMIT 1),
    'weekday', (SELECT amount_kzt FROM bb.price_rules r WHERE r.package_id=p.id AND r.rule_type='weekday' AND rule_date IS NULL ORDER BY id DESC LIMIT 1),
    'base_rows', (SELECT count(*) FROM bb.price_rules r WHERE r.package_id=p.id AND r.rule_type='base' AND rule_date IS NULL),
    'weekday_rows', (SELECT count(*) FROM bb.price_rules r WHERE r.package_id=p.id AND r.rule_type='weekday' AND rule_date IS NULL)
  ) ORDER BY p.id) FROM bb.packages p WHERE p.id IN ('happy-party','star-party','boom-bala-party')`);
const records = JSON.parse(first);
assert.equal(records.length, 3);
for (const target of TARGETS) {
  const row = records.find((candidate) => candidate.id === target.id);
  assert.ok(row, `missing ${target.id}`);
  assert.equal(row.name, target.name);
  assert.equal(row.active, true);
  assert.equal(Number(row.base), target.base);
  assert.equal(Number(row.weekday), target.weekday);
  assert.equal(Number(row.base_rows), 1);
  assert.equal(Number(row.weekday_rows), 1);
}
assert.equal(snapshot(), before, "catalog operation changed legacy catalog or business row counts");

run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", DATABASE_URL, "-f", SQL]);
assert.equal(snapshot(), before, "idempotent rerun changed legacy catalog or business row counts");
assert.equal(psql("SELECT count(*)::text FROM bb.price_rules WHERE package_id IN ('happy-party','star-party','boom-bala-party') AND rule_type IN ('base','weekday') AND rule_date IS NULL"), "6");
assert.equal(psql("SELECT count(*)::text FROM bb.packages WHERE id IN ('wow-party','magic-party','boom-party') AND is_active"), "3", "legacy package IDs must remain active");

// A conflicting pre-existing target must abort before touching any other package or price row.
psql("UPDATE bb.packages SET name='TEST CONFLICT' WHERE id='happy-party'");
const conflictedBefore = psql("SELECT json_build_object('packages',(SELECT json_agg(row_to_json(p) ORDER BY p.id) FROM bb.packages p),'prices',(SELECT json_agg(row_to_json(r) ORDER BY r.id) FROM bb.price_rules r))::text");
const rejected = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", DATABASE_URL, "-f", SQL], { cwd: ROOT, encoding: "utf8" });
assert.notEqual(rejected.status, 0, "conflicting target must be rejected");
const conflictedAfter = psql("SELECT json_build_object('packages',(SELECT json_agg(row_to_json(p) ORDER BY p.id) FROM bb.packages p),'prices',(SELECT json_agg(row_to_json(r) ORDER BY r.id) FROM bb.price_rules r))::text");
assert.equal(conflictedAfter, conflictedBefore, "failed preflight must roll back without partial writes");
console.log("PASS: first insert; idempotent rerun; approved prices; legacy IDs; business/catalogue preservation; conflicting catalogue rejected atomically");
