// Local browser E2E for the Lead Inbox workflow. Uses a temporary isolated PostgreSQL cluster and synthetic records only.
// Run after `npm run build`:
//   node --import ./scripts/site-data-loader.mjs --conditions=react-server --no-warnings tests/lead-workflow.browser.e2e.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeUser, seedFromSite, startTestDb, syntheticPhone, TEST_PASSWORD } from "./helpers/db.ts";
import { updateLeadWorkflow, instantToAlmatyLocalDateTime } from "../src/core/lead-workflow.ts";
import { findFreePort } from "../scripts/lib/cluster.mjs";

const chrome = process.env.E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error("Chrome binary unavailable; set E2E_CHROME to a local Chromium path");

const db = await startTestDb();
let server;
let browser;
try {
  await seedFromSite(db.pool);
  const manager = await makeUser(db.pool, "manager", "lead-workflow-manager@example.test");
  const secondManager = await makeUser(db.pool, "manager", "lead-workflow-second@example.test");
  const workflowName = "Synthetic workflow lead";
  const claimName = "Synthetic claim lead";
  const overdueName = "Synthetic overdue lead";
  const contacts = await db.pool.query(
    `INSERT INTO bb.contacts (name,name_key,phone_e164,source)
     VALUES ($1,lower($1),$4,'manual'), ($2,lower($2),$5,'manual'), ($3,lower($3),$6,'manual') RETURNING id`,
    [workflowName, claimName, overdueName, syntheticPhone(), syntheticPhone(), syntheticPhone()],
  );
  const leadIds = [];
  for (const contact of contacts.rows) {
    leadIds.push((await db.pool.query(
      "INSERT INTO bb.lead_requests (idempotency_key,contact_id,requested_date,status) VALUES (gen_random_uuid(),$1,'2099-10-01','new') RETURNING id",
      [contact.id],
    )).rows[0].id);
  }
  const [leadId, claimId, overdueId] = leadIds;
  const managerActor = { id: manager.id, role: "manager" };
  await updateLeadWorkflow(db.pool, managerActor, {
    leadId: overdueId, expectedVersion: 1, assignedTo: manager.id, nextAction: "await_reply",
    followUpAtLocal: instantToAlmatyLocalDateTime(new Date(Date.now() - 60_000)),
  });

  const port = await findFreePort();
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL: "", DATABASE_URL: db.url, MFA_MODE: "off", PLATFORM_PROFILE: "", PLATFORM_ROLE: "all", ALLOWED_HOSTS: "", ADMIN_ALLOWED_CIDRS: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErrors = "";
  server.stderr.on("data", (chunk) => { serverErrors += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/login`)).ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await delay(250);
  }
  assert.ok(ready, `local Platform did not become ready${serverErrors.slice(-500)}`);

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(manager.email);
  await page.getByLabel("Пароль").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(`${base}/`, { timeout: 10000 });

  await page.goto(`${base}/requests/${leadId}`, { waitUntil: "networkidle" });
  await page.getByLabel("Ответственный").selectOption(secondManager.id);
  await page.getByLabel("Конкретная задача").selectOption("call_customer");
  const firstFollowUp = instantToAlmatyLocalDateTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
  await page.getByLabel("Связаться до (Алматы)").fill(firstFollowUp);
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await page.getByRole("status").filter({ hasText: "План обработки сохранён." }).waitFor();
  await page.getByRole("heading", { name: "История обработки" }).waitFor();
  assert.equal(await page.locator(".crm-lead-history li").count(), 1);

  await updateLeadWorkflow(db.pool, { id: secondManager.id, role: "manager" }, {
    leadId, expectedVersion: 2, assignedTo: manager.id, nextAction: "prepare_offer",
    followUpAtLocal: instantToAlmatyLocalDateTime(new Date(Date.now() + 3 * 60 * 60 * 1000)),
  });
  await page.getByLabel("Ответственный").selectOption(manager.id);
  await page.getByLabel("Конкретная задача").selectOption("clarify_details");
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await page.getByRole("alert").filter({ hasText: "Заявку уже изменил другой сотрудник" }).waitFor();
  assert.equal(await page.locator(".crm-lead-history li").count(), 2, "stale submit must not append another audit event");

  await page.goto(`${base}/requests/${claimId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Взять заявку себе" }).click();
  await page.getByRole("status").filter({ hasText: "Заявка назначена вам." }).waitFor();
  const claimed = (await db.pool.query("SELECT status,assigned_to FROM bb.lead_requests WHERE id=$1", [claimId])).rows[0];
  assert.equal(claimed.status, "new", "claim does not falsely change the lead business state");
  assert.equal(claimed.assigned_to, manager.id);

  await page.goto(`${base}/requests?overdue=1`, { waitUntil: "networkidle" });
  assert.equal(await page.locator(`tr[data-lead]`).filter({ hasText: "Synthetic overdue lead" }).count(), 1);
  assert.match(await page.locator(`tr[data-lead]`).filter({ hasText: "Synthetic overdue lead" }).innerText(), /просрочено/);
  assert.deepEqual(pageErrors, [], "no browser runtime errors");
  await context.close();
  console.log("PASS browser workflow: assign, plan, audit history, stale-write refusal, claim, overdue queue");
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await db.stop();
}
