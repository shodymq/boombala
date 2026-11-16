import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic rows only. The scripts are exercised as the manager/release owner would run them.
const dir = mkdtempSync(join(tmpdir(), "sheets-review-"));
const sheet = join(dir, "sheet.csv");
const HEADER = "№ г.,Дата,Время,Наименование пакет,аниматор,кабинка,имя,номер,имя ребенка,возраст,предоплата,,дет,взр";
writeFileSync(sheet, [HEADER,
  "1,16.12.2099,13:30,Magic party,Аня,Ice room,Тест Один,87001110001,Ребёнок,8 лет,10к,П,6,2",
  "2,16.12.2099,16:40,Wow party,Аня,Roblox room,Тест Два,87001110002,Ребёнок,7 лет,по факту,П,6,2",
  "3,01.01.2020,10:00,Magic party,Аня,Ice room,Старый,87001110003,Ребёнок,7 лет,10к,П,6,2"].join("\n"));
const node = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--no-warnings", ...args], { encoding: "utf8", env: { ...process.env, ...env }, cwd: process.cwd() });

test("export keeps exact minutes, drops the past and never invents verified money", () => {
  const out = join(dir, "review.csv");
  const r = node(["scripts/sheets-manager-review.ts", "export", "--csv", sheet, "--spreadsheet", "test-sheet", "--hours", "10:00-23:00", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { futureRows: 2, needsReview: 0, candidates: 2, conflicts: 0 });
  const text = readFileSync(out, "utf8");
  assert.ok(text.includes('"13:30","17:30"') && text.includes('"16:40","20:40"'), "exact start and +240 end, no rounding");
  assert.ok(!text.includes("Старый"), "past events are archive only");
  assert.ok(text.includes("NOT_READ"), "the production match is not claimed without a production read");
});

test("plan turns only manager-approved rows with verified money into booking commands", () => {
  const review = join(dir, "reviewed.csv");
  const [head, ...rows] = readFileSync(join(dir, "review.csv"), "utf8").split("\n");
  const cols = head.split(",");
  const set = (line: string, values: Record<string, string>) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ""));
    for (const [k, v] of Object.entries(values)) cells[cols.findIndex((c) => c.includes(k))] = `"${v}"`;
    return cells.join(",");
  };
  writeFileSync(review, [head,
    set(rows[0], { manager_decision: "real", manager_agreed_price_kzt: "100000", manager_verified_prepayment_kzt: "10000", manager_prepayment_method: "cash" }),
    set(rows[1], { manager_decision: "real", manager_agreed_price_kzt: "100000" }), // no verified prepayment: must not become a booking
  ].join("\n"));
  const out = join(dir, "plan.json");
  const r = node(["scripts/sheets-manager-review.ts", "plan", "--review", review, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.bookings, 1);
  assert.equal(summary.skipped.needs_verified_prepayment, 1);
  const item = JSON.parse(readFileSync(out, "utf8")).items[0];
  assert.equal(item.start, "13:30");
  assert.equal(item.end, "17:30");
  assert.match(item.idempotencyKey, /^sheet:[0-9a-f]{64}$/);
  assert.equal(item.prepaymentKzt, 10000, "money comes from the manager column, not from the sheet");
});

test("apply refuses production and non-local targets before any network call", () => {
  const plan = join(dir, "plan.json");
  const common = ["--plan", plan, "--branch-id", "b", "--staff-email", "a@b.c", "--staff-id", "s"];
  const env = { CRM_SERVICE_TOKEN: "x".repeat(40), CRM_STAFF_ASSERTION_SECRET: "y".repeat(40) };
  const prod = node(["scripts/sheets-apply-plan.mjs", ...common, "--target", "production", "--fastapi-url", "https://api.example.com", "--apply", "yes"], env);
  assert.equal(prod.status, 3);
  assert.match(prod.stderr, /refused/);
  const remoteLocal = node(["scripts/sheets-apply-plan.mjs", ...common, "--target", "local", "--fastapi-url", "https://api.example.com"], env);
  assert.equal(remoteLocal.status, 2);
  const remoteStaging = node(["scripts/sheets-apply-plan.mjs", ...common, "--target", "staging", "--fastapi-url", "https://api.example.com"], env);
  assert.equal(remoteStaging.status, 2);
  void execFileSync;
});
