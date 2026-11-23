// Upcoming operations view browser E2E: isolated PostgreSQL, real migrations/roles, real Next server and authenticated bridge.
// Run after `npm run build`: node --import ./scripts/site-data-loader.mjs --conditions=react-server --no-warnings tests/operations-overview.e2e.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { applyRoles } from "../scripts/db-roles.ts";
import { findFreePort, initCluster, startCluster, stopCluster } from "../scripts/lib/cluster.mjs";
import { createPool } from "../src/core/db.ts";
import { migrate } from "../src/core/migrate.ts";
import { seedCatalog } from "../src/core/seed.ts";
import { createUser } from "../src/core/users.ts";
import { syntheticPhone } from "./helpers/db.ts";
import { birthdayPackages } from "../../src/data/birthdays.ts";
import { birthdayRooms } from "../../src/data/birthdayRooms.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "bb-operations-e2e-"));
const dataDir = join(tmp, "pgdata");
const dbPort = await findFreePort();
const frontPort = await findFreePort();
const bridgePort = await findFreePort();
const children = [];
let socketDir;
let owner;
let browser;
let fails = 0;
const output = [];
const check = (condition, message) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${message}`);
  if (!condition) fails += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const datesAfterToday = (days) => new Date(Date.now() + 5 * 60 * 60_000 + days * 24 * 60 * 60_000).toISOString().slice(0, 10);

function start(name, port, env) {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, VERCEL_ENV: "preview", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    if (name === "bridge") output.push(...lines);
  });
  child.stderr.on("data", (chunk) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${chunk}`);
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" });
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`server_start_timeout:${port}`);
}

async function addBooking({ date, time, roomId, packageId, label, paymentAmount, card }) {
  const contact = (await owner.query(
    "INSERT INTO bb.contacts (name,name_key,phone_e164,source) VALUES ($1,lower($1),$2,'manual') RETURNING id",
    [`SYNTHETIC_${label}_CUSTOMER`, syntheticPhone()],
  )).rows[0].id;
  const lead = (await owner.query(
    `INSERT INTO bb.lead_requests (idempotency_key,contact_id,package_id,requested_date,children,status)
     VALUES ($1,$2,$3,$4,6,'confirmed') RETURNING id`,
    [randomUUID(), contact, packageId, date],
  )).rows[0].id;
  if (paymentAmount) {
    await owner.query(
      `INSERT INTO bb.manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,recorded_by)
       VALUES ($1,$2,'cash',$3,$4)`,
      [lead, paymentAmount, `e2e-${randomUUID()}`, process.env.E2E_MANAGER_ID],
    );
  }
  const reservation = (await owner.query(
    `INSERT INTO bb.slot_reservations
       (kind,slot_date,slot_id,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,created_by,starts_at,ends_at)
     VALUES ('booking',$1,NULL,$2,$3,$4,$5,6,79900,'manager_agreed',$6,
       (($1::date + $7::time) AT TIME ZONE 'Asia/Almaty'),
       (($1::date + $7::time) AT TIME ZONE 'Asia/Almaty') + interval '4 hours')
     RETURNING id`,
    [date, roomId, lead, contact, packageId, process.env.E2E_MANAGER_ID, time],
  )).rows[0].id;
  if (card) {
    await owner.query(
      `INSERT INTO bb.booking_cards
       (reservation_id,lead_request_id,package_id,terms_version,responsible_user_id,program_status,props_status,invitation_status,created_by,updated_by)
       VALUES ($1,$2,$3,'v4.2',$4,$5,$6,$7,$4,$4)`,
      [reservation, lead, packageId, process.env.E2E_MANAGER_ID, card.programStatus, card.propsStatus, card.invitationStatus],
    );
  }
}

async function cleanup() {
  await browser?.close().catch(() => {});
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(resolve, 3000).unref();
    }
  })));
  await owner?.end().catch(() => {});
  if (socketDir) stopCluster(dataDir, socketDir);
  rmSync(tmp, { recursive: true, force: true });
}

try {
  initCluster(dataDir);
  socketDir = startCluster(dataDir, dbPort, { fast: true });
  const databaseUrl = `postgres://postgres@127.0.0.1:${dbPort}/postgres`;
  owner = createPool(databaseUrl, { max: 8 });
  await owner.query("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS");
  await migrate(owner, join(root, "migrations"));
  await seedCatalog(owner, {
    packages: birthdayPackages.map((item) => ({ id: item.id, name: item.copy.ru.name, price: item.weekendPrice, weekdayPrice: item.weekdayPrice })),
    rooms: birthdayRooms.map((item) => ({ id: item.id, name: item.name })),
  });
  const apiPassword = `api-${randomBytes(24).toString("hex")}A1`;
  const adminPassword = `admin-${randomBytes(24).toString("hex")}B2`;
  await applyRoles(owner, { apiPassword, adminPassword });
  const managerPassword = `Ops-E2E-${randomBytes(24).toString("hex")}aA1!`;
  const manager = await createUser(owner, null, { email: "ops-manager@e2e.invalid", name: "Synthetic Manager", role: "manager", password: managerPassword });
  const editorPassword = `Ops-E2E-${randomBytes(24).toString("hex")}bB2!`;
  await createUser(owner, null, { email: "ops-editor@e2e.invalid", name: "Synthetic Editor", role: "editor", password: editorPassword });
  process.env.E2E_MANAGER_ID = manager.id;

  const roomIds = (await owner.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order,id LIMIT 2")).rows.map((row) => row.id);
  assert.equal(roomIds.length, 2, "isolated catalog has two rooms");
  await addBooking({
    date: datesAfterToday(2), time: "14:00", roomId: roomIds[0], packageId: "boom-bala-party", label: "PAID",
    paymentAmount: 10000, card: { programStatus: "approved", propsStatus: "ready", invitationStatus: "sent" },
  });
  await addBooking({
    date: datesAfterToday(3), time: "15:00", roomId: roomIds[1], packageId: "star-party", label: "NO_FACT",
    paymentAmount: 0, card: { programStatus: "draft", propsStatus: "preparing", invitationStatus: "not_applicable" },
  });
  const importedDate = datesAfterToday(4);
  const importedBlock = (await owner.query(
    `INSERT INTO bb.slot_reservations
       (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at)
     VALUES ('block',$1,NULL,$2,'SYNTHETIC_PRIVATE_NOTE',$3,
       (($1::date + '13:00'::time) AT TIME ZONE 'Asia/Almaty'),
       (($1::date + '13:00'::time) AT TIME ZONE 'Asia/Almaty') + interval '4 hours')
     RETURNING id`,
    [importedDate, roomIds[0], manager.id],
  )).rows[0].id;
  const sourceKey = randomBytes(32).toString("hex");
  const sheetPhoneCanary = syntheticPhone();
  await owner.query(
    `INSERT INTO bb.sheet_sync_records
       (source_key,fingerprint,legacy_key_prefix,reservation_id,state,source_row_number,source_payload)
     VALUES ($1,$2,$3,$4,'active',10,$5::jsonb)`,
    [sourceKey, randomBytes(32).toString("hex"), sourceKey.slice(0, 20), importedBlock, JSON.stringify({
      date: importedDate, time: "13:00", room: "Ice Room", package: "SYNTHETIC_SHEET_PACKAGE",
      client: "SYNTHETIC_SHEET_CUSTOMER", phone: sheetPhoneCanary, child: "SYNTHETIC_SHEET_CHILD", comment: "SYNTHETIC_SHEET_COMMENT",
    })],
  );

  const adminUrl = new URL(databaseUrl);
  adminUrl.username = "bb_admin";
  adminUrl.password = adminPassword;
  const serviceToken = randomBytes(32).toString("hex");
  start("bridge", bridgePort, {
    DATABASE_URL: adminUrl.toString(), CRM_SERVICE_TOKEN: serviceToken, PLATFORM_ROLE: "admin",
    CRM_PERF_LOG: "1", DATABASE_POOL_MAX: "5",
  });
  start("frontend", frontPort, {
    CRM_BRIDGE_MODE: "legacy", CRM_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
    CRM_SERVICE_TOKEN: serviceToken, UNIFIED_FASTAPI_CRM_ENABLED: "1", DATABASE_URL: "", MFA_MODE: "off",
  });
  await waitForServer(bridgePort);
  await waitForServer(frontPort);

  async function rpcAs(email, password, op, input) {
    const headers = { "Content-Type": "application/json", "X-CRM-Service-Token": serviceToken };
    const login = await fetch(`http://127.0.0.1:${bridgePort}/api/bridge/auth/login`, {
      method: "POST", headers,
      body: JSON.stringify({ email, password, mfaRequired: false, ip: "127.0.0.1", userAgent: "isolated-e2e" }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200, "synthetic isolated test account authenticates through bridge auth");
    assert.equal(loginBody.ok, true);
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/bridge/rpc`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${loginBody.token}`, "X-CRM-Op": op },
      body: JSON.stringify({ op, input }),
    });
    return { response, body: await response.json() };
  }

  const rawOperations = await rpcAs("ops-manager@e2e.invalid", managerPassword, "operations.overview", {
    dates: Array.from({ length: 7 }, (_, offset) => datesAfterToday(offset)),
  });
  check(rawOperations.response.status === 200, "allowlisted operations RPC returns successfully for manager");
  const rawReservations = rawOperations.body.reservations;
  const rawBlock = rawReservations.find((item) => item.id === importedBlock);
  check(Boolean(rawBlock) && rawBlock.kind === "block" && rawBlock.sourceState === "active", "linked imported block is returned as an unconfirmed block");
  const rpcText = JSON.stringify(rawOperations.body);
  for (const canary of ["SYNTHETIC_SHEET_CUSTOMER", sheetPhoneCanary, "SYNTHETIC_SHEET_CHILD", "SYNTHETIC_SHEET_COMMENT", "SYNTHETIC_PRIVATE_NOTE", "SYNTHETIC_SHEET_PACKAGE"]) {
    check(!rpcText.includes(canary), `operations RPC excludes private source data (${canary.startsWith("SYNTHETIC_") ? "synthetic field" : "phone"})`);
  }
  check(rawBlock && Object.keys(rawBlock).sort().join(",") === "card,date,id,kind,packageName,paidKzt,paymentStatus,room,sourceState,startsAt,status", "operations RPC returns only allowlisted fields");
  check(rawBlock?.packageName === "Пакет из таблицы — не проверен", "free-text package field is replaced by a safe review label");
  check(rawBlock?.paidKzt === 0 && rawBlock?.paymentStatus === "unpaid" && rawBlock?.card === null, "imported source payment cell is not returned as a payment fact");

  const editorRpc = await rpcAs("ops-editor@e2e.invalid", editorPassword, "operations.overview", {
    dates: Array.from({ length: 7 }, (_, offset) => datesAfterToday(offset)),
  });
  check(editorRpc.response.status === 403, "operations RPC denies editor role directly");
  output.length = 0; // Isolate the following assertion to the server-rendered page call.

  const executable = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  browser = await chromium.launch({ executablePath: executable, headless: true });
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${frontPort}/login`);
  await page.fill('input[type="email"]', "ops-manager@e2e.invalid");
  await page.fill('input[type="password"]', managerPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByRole("link", { name: "Ближайшие праздники" }).count() === 1, "manager sees the operations navigation link");
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`http://127.0.0.1:${frontPort}/`);
  const analyticsText = (await page.getByTestId("dash-analytics").innerText()).replace(/\s+/g, " ");
  check(analyticsText.includes("Заявки и предстоящие праздники"), "manager dashboard shows the aggregate analytics snapshot");
  check(analyticsText.includes("Подтверждённые брони 2") && analyticsText.includes("Блокировки комнат 1"), "dashboard separates two bookings from one imported block");
  check(analyticsText.includes("не является выручкой") || analyticsText.includes("не является выручкой."), "dashboard labels manual prepayment facts as not revenue");

  const started = performance.now();
  await page.goto(`http://127.0.0.1:${frontPort}/operations`);
  await page.getByTestId("operations-events").waitFor({ timeout: 20000 });
  const elapsedMs = Math.round(performance.now() - started);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(await page.getByTestId("operations-event").count() === 3, "two bookings and the linked Sheets record render in the upcoming list");
  check(text.includes("Ice Room") || text.includes("Roblox Room"), "room is rendered from the timeline catalog");
  check(text.includes("BOOM BALA PARTY") && text.includes("STAR PARTY"), "package names are rendered from Booking V2 timeline data");
  check(text.includes("Synthetic Manager"), "responsible manager is shown");
  check(text.includes("Согласована") && text.includes("Готовы") && text.includes("Отправлено"), "program, props and applicable invitation states are shown");
  check(text.includes("Подтверждено: 10 000 ₸") && text.includes("Факт не записан"), "confirmed payment fact and missing fact are visibly distinct");
  check(text.includes("Импортировано · требуется ручная проверка") && text.includes("Пакет из таблицы — не проверен"), "imported block is clearly flagged for review and not presented as a confirmed booking");
  const importedEventText = await page.getByTestId("operations-event").filter({ hasText: "Пакет из таблицы — не проверен" }).innerText();
  check(!importedEventText.includes("Предоплата") && !importedEventText.includes("Факт не записан"), "imported block does not show a financial-fact status");
  check(!text.includes("SYNTHETIC_PAID_CUSTOMER") && !text.includes("SYNTHETIC_NO_FACT_CUSTOMER") && !text.includes("SYNTHETIC_SHEET_CUSTOMER") && !text.includes(sheetPhoneCanary) && !text.includes("SYNTHETIC_SHEET_CHILD") && !text.includes("SYNTHETIC_SHEET_COMMENT"), "customer names, phone, child and comment are absent from rendered page");
  check(pageErrors.length === 0, "no browser page errors");

  for (let attempt = 0; attempt < 30 && output.filter((line) => /op=operations\.overview status=200/.test(line)).length < 1; attempt += 1) await sleep(100);
  const operationsCalls = output.filter((line) => /op=operations\.overview status=200/.test(line));
  check(operationsCalls.length === 1, "the server page uses one safe operations RPC instead of seven full PII timelines");
  console.log(`  info measured local browser navigation: ${elapsedMs} ms (isolated local PG; not a Production performance result)`);

  const editorPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await editorPage.goto(`http://127.0.0.1:${frontPort}/login`);
  await editorPage.fill('input[type="email"]', "ops-editor@e2e.invalid");
  await editorPage.fill('input[type="password"]', editorPassword);
  await editorPage.click('button[type="submit"]');
  await editorPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
  await editorPage.setViewportSize({ width: 390, height: 844 });
  check(await editorPage.getByRole("link", { name: "Ближайшие праздники" }).count() === 0, "editor does not see the operations link");
  await editorPage.goto(`http://127.0.0.1:${frontPort}/`);
  check(await editorPage.getByTestId("dash-analytics").count() === 0, "editor does not receive request, booking or payment aggregates");
  await editorPage.goto(`http://127.0.0.1:${frontPort}/operations`);
  await editorPage.waitForURL((url) => url.pathname === "/", { timeout: 10000 });
  check(new URL(editorPage.url()).pathname === "/", "editor is denied direct route access by server-side RBAC");
  await editorPage.close();
} finally {
  await cleanup();
}

if (fails > 0) process.exitCode = 1;
else console.log("PASS: upcoming operations browser E2E against isolated PostgreSQL");
