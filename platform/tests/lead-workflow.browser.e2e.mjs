// Local browser E2E for the Lead Inbox workflow. Uses a temporary isolated PostgreSQL cluster and synthetic records only.
// Run after `npm run build`:
//   node --import ./scripts/site-data-loader.mjs --conditions=react-server --no-warnings tests/lead-workflow.browser.e2e.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUser, seedFromSite, startTestDb, syntheticPhone, TEST_PASSWORD } from "./helpers/db.ts";
import { updateLeadWorkflow, instantToAlmatyLocalDateTime } from "../src/core/lead-workflow.ts";
import { findFreePort } from "../scripts/lib/cluster.mjs";

const chrome = process.env.E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserType = process.env.E2E_BROWSER === "webkit" ? webkit : chromium;
if (browserType === chromium && !existsSync(chrome)) throw new Error("Chrome binary unavailable; set E2E_CHROME to a local Chromium path");
const artifacts = process.env.E2E_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "boombala-mobile-crm-"));
mkdirSync(artifacts, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: false });

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

  browser = await browserType.launch({ ...(browserType === chromium ? { executablePath: chrome } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(manager.email);
  await page.getByLabel("Пароль").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL(`${base}/`, { timeout: 10000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile dashboard has no horizontal page overflow");
  await shot(page, "01-mobile-overview");

  await page.goto(`${base}/requests?status=new`, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile lead list has no horizontal page overflow");
  assert.equal(await page.getByRole("link", { name: "Новые" }).getAttribute("aria-current"), "page");
  const leadRow = page.locator(`tr[data-lead]`).filter({ hasText: workflowName });
  const callLink = leadRow.locator('a[href^="tel:"]');
  assert.equal(await callLink.count(), 1, "a manager can call directly from the lead card");
  const callTarget = await callLink.boundingBox();
  assert.ok(callTarget && callTarget.width >= 44 && callTarget.height >= 44, "the mobile call action meets the 44px touch target");
  const filterTargets = await page.locator(".crm-requests-tabs a").evaluateAll((els) => els.map((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  assert.ok(filterTargets.length >= 3 && filterTargets.every((rect) => rect.width >= 44 && rect.height >= 44), "mobile request filters meet the 44px touch target");
  const callHref = await callLink.getAttribute("href");
  assert.match(callHref, /^tel:\+?\d{8,15}$/);
  const statusBeforeCall = (await db.pool.query("SELECT status FROM bb.lead_requests WHERE id=$1", [leadId])).rows[0].status;
  assert.equal(statusBeforeCall, "new", "the call link does not change the lead status");
  await shot(page, "02-mobile-requests");
  await leadRow.scrollIntoViewIfNeeded();
  await shot(page, "02b-mobile-request-card");
  await leadRow.getByRole("button", { name: "В работу" }).click();
  await page.waitForURL(`${base}/requests?notice=status`, { timeout: 10000 });
  const statusAfterAction = (await db.pool.query("SELECT status FROM bb.lead_requests WHERE id=$1", [leadId])).rows[0].status;
  assert.equal(statusAfterAction, "in_progress", "manager can update the lead status from the mobile queue");

  await page.goto(`${base}/requests/${leadId}`, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile lead card has no horizontal page overflow");
  assert.match(await page.locator('a[href^="tel:"]').first().getAttribute("href"), /^tel:/);
  await shot(page, "03-mobile-lead-card");
  await page.locator("[data-lead-workflow-form]").scrollIntoViewIfNeeded();
  await shot(page, "03b-mobile-follow-up-form");
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
  const auditBeforeStaleSubmit = (await db.pool.query(
    "SELECT count(*)::int AS count FROM bb.audit_log WHERE entity_type='lead_request' AND entity_id=$1 AND action IN ('lead.claimed','lead.workflow_updated')",
    [leadId],
  )).rows[0].count;
  await page.getByLabel("Ответственный").selectOption(manager.id);
  await page.getByLabel("Конкретная задача").selectOption("clarify_details");
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await page.getByRole("alert").filter({ hasText: "Другой сотрудник обновил эту заявку" }).waitFor();
  assert.equal(await page.getByLabel("Ответственный").inputValue(), manager.id, "the stale form keeps the manager's selection");
  assert.equal(await page.getByLabel("Конкретная задача").inputValue(), "clarify_details", "the stale form keeps the follow-up selection");
  assert.equal(await page.getByLabel("Связаться до (Алматы)").inputValue(), firstFollowUp, "the stale form keeps the datetime the manager entered");
  const auditAfterStaleSubmit = (await db.pool.query(
    "SELECT count(*)::int AS count FROM bb.audit_log WHERE entity_type='lead_request' AND entity_id=$1 AND action IN ('lead.claimed','lead.workflow_updated')",
    [leadId],
  )).rows[0].count;
  assert.equal(auditAfterStaleSubmit, auditBeforeStaleSubmit, "stale submit must not append another audit event");
  await shot(page, "04-mobile-stale-follow-up");

  await page.goto(`${base}/requests/${claimId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Взять заявку себе" }).click();
  await page.getByRole("status").filter({ hasText: "Заявка назначена вам." }).waitFor();
  const claimed = (await db.pool.query("SELECT status,assigned_to FROM bb.lead_requests WHERE id=$1", [claimId])).rows[0];
  assert.equal(claimed.status, "new", "claim does not falsely change the lead business state");
  assert.equal(claimed.assigned_to, manager.id);

  await page.goto(`${base}/requests?overdue=1`, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "overdue queue has no horizontal page overflow");
  assert.equal(await page.locator(`tr[data-lead]`).filter({ hasText: "Synthetic overdue lead" }).count(), 1);
  assert.match(await page.locator(`tr[data-lead]`).filter({ hasText: "Synthetic overdue lead" }).innerText(), /просрочено/);
  for (const width of [320, 360, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    for (const path of ["/", "/requests?status=in_progress", `/requests/${leadId}`]) {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${path} at ${width}px has no horizontal page overflow (found ${overflow}px)`);
      if (width === 390 && path === "/requests?status=in_progress") await shot(page, "05-mobile-requests-390");
      if (width === 1440) await shot(page, `06-desktop-${path === "/" ? "overview" : path.startsWith("/requests/") ? "lead-card" : "requests"}-1440`);
    }
  }
  assert.deepEqual(pageErrors, [], "no browser runtime errors");
  await context.close();
  console.log(`PASS mobile workflow: login, request queue, tel link, follow-up, audit, stale-write refusal, claim, overdue queue; screenshots=${artifacts}`);
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await db.stop();
}
