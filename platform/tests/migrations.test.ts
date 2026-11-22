// TEST FIXTURES: all identities, phone values, emails, and auth values below are synthetic and used only in isolated tests.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { migrate } from "../src/core/migrate.ts";
import { MIGRATIONS_DIR, startTestDb, syntheticPhone, type TestDb } from "./helpers/db.ts";

describe("migrations and DB-level guarantees", () => {
  let db: TestDb;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  it("is idempotent: a second run applies nothing", async () => {
    const second = await migrate(db.pool, MIGRATIONS_DIR);
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length);
  });

  it("refuses an already applied migration that was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-mig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "001_core.sql"), "-- tampered\nSELECT 1;");
      await assert.rejects(() => migrate(db.pool, dir), /changed after it was applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing migration rolls back completely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-mig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "999_broken.sql"), "CREATE TABLE half_done (id int); SELECT 1/0;");
      await assert.rejects(() => migrate(db.pool, dir), /999_broken.sql failed/);
      const { rows } = await db.pool.query("SELECT to_regclass('half_done') AS t");
      assert.equal(rows[0].t, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps historical slots and accepts minute-precise four-hour starts", async () => {
    const { rows } = await db.pool.query("SELECT id, to_char(starts_at,'HH24:MI') s, to_char(ends_at,'HH24:MI') e FROM time_slots ORDER BY starts_at, id");
    assert.deepEqual(rows, [
      { id: 1, s: "10:00", e: "14:00" },
      { id: 4, s: "11:00", e: "15:00" },
      { id: 5, s: "12:00", e: "16:00" },
      { id: 6, s: "13:00", e: "17:00" },
      { id: 2, s: "14:00", e: "18:00" },
      { id: 7, s: "15:00", e: "19:00" },
      { id: 8, s: "16:00", e: "20:00" },
      { id: 9, s: "17:00", e: "21:00" },
      { id: 3, s: "18:00", e: "22:00" },
    ]);
    await db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (10, '13:15', '17:15')");
    await assert.rejects(() => db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (11, '13:16', '17:00')"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO time_slots (id, starts_at, ends_at) VALUES (12, '13:15', '17:15')"), /unique/i);
    await assert.rejects(() => db.pool.query("DELETE FROM time_slots WHERE id = 1"), /cannot be deleted/);
  });

  it("017 preserves existing reservation IDs and makes only the named general halls non-exclusive", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "bb-before-017-"));
    const pre017 = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "017_sheets_live_sync.sql")) {
        cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
      }
      await migrate(pre017.pool, oldDir);
      const user = await pre017.pool.query<{ id: string }>("INSERT INTO users (email,name,password_hash,role) VALUES ('synthetic@example.invalid','Synthetic migration test','x','manager') RETURNING id");
      await pre017.pool.query("INSERT INTO rooms (id,name) VALUES ('legacy-room-preserve','Legacy room')");
      const before = await pre017.pool.query<{ id: string }>(
        "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-01-20',NULL,'legacy-room-preserve','kept', $1,'2099-01-20 10:00:00+05','2099-01-20 14:00:00+05') RETURNING id", [user.rows[0].id]);
      await migrate(pre017.pool, MIGRATIONS_DIR);
      const after = await pre017.pool.query<{ id: string; occupancy_key: string }>("SELECT id,occupancy_key FROM slot_reservations WHERE id=$1", [before.rows[0].id]);
      assert.deepEqual(after.rows, [{ id: before.rows[0].id, occupancy_key: "legacy-room-preserve" }]);
      assert.equal((await pre017.pool.query("SELECT 1 FROM rooms WHERE id='general-hall' AND occupancy_mode='shared'")).rowCount, 1);
      assert.equal((await pre017.pool.query("SELECT 1 FROM rooms WHERE id='general-hall-2f' AND occupancy_mode='shared'")).rowCount, 1);
    } finally {
      await pre017.stop();
      rmSync(oldDir, { recursive: true, force: true });
    }

    const collisionDb = await startTestDb({ migrate: false });
    const collisionDir = mkdtempSync(join(tmpdir(), "bb-room-collision-"));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "017_sheets_live_sync.sql")) {
        cpSync(join(MIGRATIONS_DIR, file), join(collisionDir, file));
      }
      await migrate(collisionDb.pool, collisionDir);
      await collisionDb.pool.query("INSERT INTO rooms (id,name) VALUES ('general-hall','Occupied legacy catalog name')");
      await assert.rejects(() => migrate(collisionDb.pool, MIGRATIONS_DIR), /017_sheets_live_sync\.sql failed: general-hall catalog collision/);
      const unchanged = await collisionDb.pool.query("SELECT name FROM rooms WHERE id='general-hall'");
      assert.equal(unchanged.rows[0].name, "Occupied legacy catalog name");
      assert.equal((await collisionDb.pool.query("SELECT to_regclass('bb.sheet_sync_runs') t")).rows[0].t, null);
    } finally {
      await collisionDb.stop();
      rmSync(collisionDir, { recursive: true, force: true });
    }

    const actor = await db.pool.query<{ id: string }>("INSERT INTO users (email,name,password_hash,role) VALUES ('synthetic@example.invalid','Synthetic shared-zone test','x','manager') RETURNING id");
    const sharedOne = await db.pool.query<{ id: string }>(
      "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'general-hall','one',$1,'2099-02-20 10:00:00+05','2099-02-20 14:00:00+05') RETURNING id", [actor.rows[0].id]);
    const sharedTwo = await db.pool.query<{ id: string }>(
      "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'general-hall','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05') RETURNING id", [actor.rows[0].id]);
    assert.notEqual(sharedOne.rows[0].id, sharedTwo.rows[0].id);
    await db.pool.query("INSERT INTO rooms (id,name) VALUES ('exclusive-zone-test','Exclusive test')");
    await db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','one',$1,'2099-02-20 10:00:00+05','2099-02-20 14:00:00+05')", [actor.rows[0].id]);
    await assert.rejects(() => db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05')", [actor.rows[0].id]), (error: { code?: string }) => error.code === "23P01");
  });

  it("018 on top of populated 017 keeps every old package, price, reservation and payment; legacy sale flags wait for site cutover", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "bb-before-018-"));
    const pre018 = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "018")) cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
      await migrate(pre018.pool, oldDir);
      const q = (sql: string, p: unknown[] = []) => pre018.pool.query(sql, p);
      await q("INSERT INTO packages (id,name,sort_order) VALUES ('wow-party','WOW PARTY',0),('magic-party','MAGIC PARTY',1),('boom-party','BOOM PARTY',2)");
      await q("INSERT INTO price_rules (package_id,rule_type,amount_kzt) VALUES ('wow-party','base',37900),('wow-party','weekday',26530),('boom-party','base',79990)");
      const user = (await q("INSERT INTO users (email,name,password_hash,role) VALUES ('synthetic@example.invalid','M','x','manager') RETURNING id")).rows[0].id;
      const contact = (await q("INSERT INTO contacts (name,name_key,phone_e164,source) VALUES ('Synthetic historical','историч',$1,'manual') RETURNING id", [syntheticPhone()])).rows[0].id;
      const lead = (await q("INSERT INTO lead_requests (idempotency_key,contact_id,package_id,requested_date,children,status) VALUES (gen_random_uuid(),$1,'wow-party','2099-03-10',6,'confirmed') RETURNING id", [contact])).rows[0].id;
      const reservation = (await q(
        `INSERT INTO slot_reservations (kind,slot_date,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,created_by,starts_at,ends_at)
         SELECT 'booking','2099-03-10',id,$1,$2,'wow-party',6,37900,'base',$3,'2099-03-10 13:00+05','2099-03-10 17:00+05' FROM rooms ORDER BY sort_order LIMIT 1 RETURNING id`,
        [lead, contact, user],
      )).rows[0].id;
      await q("INSERT INTO manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,recorded_by) VALUES ($1,10000,'cash','key-018-history',$2)", [lead, user]);
      const before = {
        prices: (await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n,
        reservation: (await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0],
      };

      await migrate(pre018.pool, MIGRATIONS_DIR);

      assert.deepEqual((await q("SELECT id,is_active FROM packages ORDER BY id")).rows.map((r) => `${r.id}:${r.is_active}`), [
        "boom-bala-party:true", "boom-party:true", "happy-party:true", "magic-party:true", "star-party:true", "wow-party:true",
      ]);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 0, "the migration does not retire legacy IDs before the site switch");
      assert.equal((await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n, before.prices, "price history is untouched");
      assert.deepEqual((await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0], before.reservation, "the booking and its agreed price are untouched");
      assert.equal((await q("SELECT count(*)::int n FROM manual_payment_facts WHERE lead_request_id=$1", [lead])).rows[0].n, 1, "the payment fact is untouched");
      assert.equal((await q("SELECT status FROM lead_requests WHERE id=$1", [lead])).rows[0].status, "confirmed");
      assert.equal((await q("SELECT count(*)::int n FROM booking_cards")).rows[0].n, 0, "no card is invented for an old booking");
      // Once explicitly archived after cutover, a later seed/update cannot reopen the legacy ID.
      await q("INSERT INTO package_archive (package_id, reason) VALUES ('magic-party','test retirement')");
      await q("UPDATE packages SET is_active = false WHERE id = 'magic-party'");
      await q("UPDATE packages SET is_active = true WHERE id = 'magic-party'");
      assert.equal((await q("SELECT is_active FROM packages WHERE id='magic-party'")).rows[0].is_active, false);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 1);z��$z{-���jם;
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
  check(await page.getByRole("link", { name: "Ближайшие праздники" }).count() === 1, "manager sees the operations navigation link");
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
