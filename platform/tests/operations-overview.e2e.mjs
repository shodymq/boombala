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
  const page =�Ov��$z{-���jםd"], "QR + enquiry: reported as untouchable");
      assert.ok(!late.eligible.some((i) => i.contactId === withLead));
      assert.ok(late.totals.outsideQrRule >= 1, "enquiry/booking-only contacts are outside the QR rule");

      const text = JSON.stringify(late);
      for (const secret of ["Срок", qrOnlyPhone, withLeadPhone, "Одиночный"]) assert.ok(!text.includes(secret), `the report must not contain ${secret}`);

      const dry = await runRetention(db.pool, owner, { now: plusMonths(reg, 12, 1000) });
      assert.deepEqual({ dryRun: dry.dryRun, processed: dry.processed }, { dryRun: true, processed: 0 });
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.contacts WHERE anonymized_at IS NOT NULL")), anonymisedBefore, "a dry run changes nothing");
    });

    it("a real run is refused while automatic processing is off or not legally confirmed; the settings cannot skip the confirmation", async () => {
      const now = plusMonths(new Date(), 13);
      await assert.rejects(() => runRetention(db.pool, owner, { dryRun: false, now }), RetentionDisabledError);
      await assert.rejects(() => updateRetentionSettings(db.pool, owner, { autoEnabled: true }), (e: unknown) => e instanceof ValidationError && "autoEnabled" in e.fields);
      await assert.rejects(() => q("UPDATE bb.retention_settings SET auto_enabled = true"), /check constraint/i, "the database enforces it too");
      for (const bad of [0, 121, 1.5, Number.NaN]) await assert.rejects(() => updateRetentionSettings(db.pool, owner, { qrMonths: bad }), ValidationError);
      assert.deepEqual(await getRetentionSettings(db.pool, owner), { qrMonths: 12, autoEnabled: false, legalConfirmedAt: null });
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'retention.run'"), 0);
    });

    it("after the Owner records the confirmation and enables it, a run processes only eligible QR contacts and is repeatable", async () => {
      const keepPhone = syntheticPhone();
      const gonePhone = syntheticPhone();
      const tiedPhone = syntheticPhone();
      const keep = await contactOf((await register("Срок Свежий", keepPhone)).registrationId); // registered "today"
      const gone = await contactOf((await register("Срок Истёк", gonePhone)).registrationId);
      const tied = await contactOf((await register("Срок Связан", tiedPhone)).registrationId);
      await submitLead(db.pool, lead("Срок Связан", tiedPhone));
      const settings = await updateRetentionSettings(db.pool, owner, { legalConfirmed: true, autoEnabled: true, qrMonths: 12 }, meta);
      assert.equal(settings.autoEnabled, true);
      assert.ok(settings.legalConfirmedAt);

      // time machine: 13 months from "today" makes everything registered so far expired
      const now = plusMonths(new Date(), 13);
      const preview = await retentionReport(db.pool, owner, now);
      const wouldTouch = preview.eligible.map((i) => i.contactId);
      assert.ok(wouldTouch.includes(gone) && wouldTouch.includes(keep), "both are past the period at that date");
      assert.ok(!wouldTouch.includes(tied));

      const run = await runRetention(db.pool, owner, { dryRun: false, now }, meta);
      assert.equal(run.processed, wouldTouch.length);
      for (const id of wouldTouch) {
        assert.equal(await scalar("SELECT anonymized_at IS NOT NULL v FROM bb.contacts WHERE id = $1", [id]), true);
        const ev = await events(id);
        assert.ok(ev.some((e) => e.event === "revoked" && e.note === "retention_expired"), "the revocation is part of the history");
        assert.ok(ev.every((e) => e.ip_hash === null && e.user_agent === null));
      }
      assert.equal(await scalar("SELECT anonymized_at IS NULL v FROM bb.contacts WHERE id = $1", [tied]), true, "the contact with an enquiry was left alone");
      assert.equal(await scalar("SELECT phone_e164 v FROM bb.contacts WHERE id = $1", [tied]), tiedPhone);

      const again = await runRetention(db.pool, owner, { dryRun: false, now }, meta);
      assert.equal(again.processed, 0, "repeatable: nothing left to do");
      const audit = await auditText();
      assert.ok(audit.includes("retention.run") && audit.includes("retention.settings_changed"));
      for (const secret of ["Срок Истёк", gonePhone, "Срок Связан", tiedPhone]) assert.ok(!audit.includes(secret));

      // withdrawing the confirmation switches automatic processing off again
      const off = await updateRetentionSettings(db.pool, owner, { legalConfirmed: false });
      assert.deepEqual({ auto: off.autoEnabled, confirmed: off.legalConfirmedAt }, { auto: false, confirmed: null });
      await assert.rejects(() => runRetention(db.pool, owner, { dryRun: false, now }), RetentionDisabledError);
    });
  });

  describe("what a withdrawal covers, and what is left afterwards", () => {
    it("one button withdraws EVERY personal-data consent of the contact: the QR one and the one given with the enquiry, also under another document version", async () => {
      const name = "Раиса Обаесогласия";
      const phone = syntheticPhone();
      const c = await contactOf((await register(name, phone)).registrationId); // QR under the current version
      const oldDoc = String(await scalar("SELECT id v FROM bb.legal_documents WHERE kind = 'personal_data_consent' AND status = 'published'"));
      const next = await createDraft(db.pool, owner, { kind: "personal_data_consent", title: "новая редакция", body: "Текст personal_data_consent 2" });
      await approveDocument(db.pool, owner, next.id);
      await publishDocument(db.pool, owner, next.id);
      const l = await submitLead(db.pool, lead(name, phone)); // the enquiry is accepted under the NEW version
      assert.equal(String(await scalar("SELECT contact_id v FROM bb.lead_requests WHERE id = $1", [l.leadId])), c);

      const given = (await events(c)).filter((e) => e.event === "given" && e.document_id);
      const docs = new Set(given.map((e) => String(e.document_id)));
      assert.ok(docs.has(oldDoc) && docs.has(String(next.id)), "the contact holds consents under two document versions");

      const rev = await revokeConsent(db.pool, owner, c, meta);
      assert.equal(rev.revokedDocuments, 2, "both versions are withdrawn");
      assert.equal(rev.assessment.consentActive, false);

      const card = (await getContact(db.pool, owner, c))!;
      const consents = card.consents;
      assert.deepEqual(consents.filter((e) => e.event === "revoked").map((e) => e.origin), ["staff", "staff"]);
      assert.ok(consents.some((e) => e.event === "given" && e.origin === "qr"), "the history says which consent came from the QR registration");
      assert.ok(consents.some((e) => e.event === "given" && e.origin === "enquiry" && e.enquirySeq !== null), "and which one came with an enquiry (with its number)");
      // the withdrawal changed nothing else: the enquiry and the contact stay
      assert.equal(await scalar("SELECT phone_e164 v FROM bb.contacts WHERE id = $1", [c]), phone);
      assert.equal(await scalar("SELECT status v FROM bb.lead_requests WHERE id = $1", [l.leadId]), "new");
      assert.deepEqual((await assessContact(db.pool, owner, c))!.blockers, ["open_enquiry", "enquiry_record"]);
    });

    it("after anonymisation no table of the schema still holds the name, the phone, the address or the browser of the visitor", async () => {
      const name = "Реидент Проверкин";
      const phone = syntheticPhone();
      // values that exist nowhere else in this database, so the search below can only find this visitor's traces
      const reg = await submitConsentV(db.pool, { idempotencyKey: randomUUID(), name, phone, childrenCount: 1, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.77", ipPepper: "pepper-reident", userAgent: "UniqueBrowser/9.99-reident" });
      const c = await contactOf(reg.registrationId);
      const ipHash = hashIp("203.0.113.77", "pepper-reident")!;
      assert.ok(JSON.stringify((await q("SELECT ip_hash, user_agent FROM bb.consent_events WHERE contact_id = $1", [c])).rows).includes(ipHash), "before: the hash and the browser string are stored");
      await revokeConsent(db.pool, owner, c, meta);
      await anonymizeContact(db.pool, owner, c, meta);
      const tables = (await q("SELECT table_name t FROM information_schema.tables WHERE table_schema = 'bb' AND table_type = 'BASE TABLE'")).rows.map((r) => String(r.t));
      assert.ok(tables.includes("consent_events") && tables.includes("audit_log") && tables.includes("export_log"));
      let dump = "";
      for (const t of tables) dump += JSON.stringify((await q(`SELECT x::text AS row FROM bb."${t}" x`)).rows);
      for (const needle of ["Реидент", "Проверкин", phone, phone.replace(/\D/g, ""), "203.0.113.77", ipHash, "UniqueBrowser"]) {
        assert.ok(!dump.includes(needle), `no table may contain ${needle}`);
      }
      // what remains about the contact: an id, the times of its registrations and the document versions, nothing that names a person
      const row = (await q("SELECT name, name_key, phone_e164, source, marketing_opt_in, phone_verification FROM bb.contacts WHERE id = $1", [c])).rows[0];
      assert.deepEqual(row, { name: ANONYMIZED_NAME, name_key: `anon:${c}`, phone_e164: null, source: "qr", marketing_opt_in: false, phone_verification: "unverified" });
    });
  });

  describe("where personal data may remain", () => {
    it("the CRM and exports show an anonymised contact without its old name or phone", async () => {
      const phone = syntheticPhone();
      const c = await contactOf((await register("Видимость Проверка", phone)).registrationId);
      await revokeConsent(db.pool, owner, c);
      await anonymizeContact(db.pool, owner, c);
      const list = await listContacts(db.pool, owner, { q: "Видимость" });
      assert.equal(list.total, 0, "it can no longer be found by the old name");
      const card = await getContact(db.pool, owner, c);
      assert.equal(card!.contact.name, ANONYMIZED_NAME);
      assert.equal(card!.contact.phone, null);
      const csv = (await exportContacts(db.pool, owner, { format: "csv", columns: ["name", "phone"] })).body.toString("utf8");
      assert.ok(!csv.includes("Видимость") && !csv.includes(phone));
    });

    it("the export log keeps the fact that a search was used, not what was typed (it is append-only)", async () => {
      const searchPhone = syntheticPhone();
      await exportContacts(db.pool, owner, { format: "csv", columns: ["name"], filters: { q: searchPhone } });
      const row = (await q("SELECT filters FROM bb.export_log ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(row.filters.q, "[redacted]");
      assert.ok(!JSON.stringify((await q("SELECT filters, columns FROM bb.export_log")).rows).includes(searchPhone));
    });

    it("nothing in the audit log or the Telegram outbox names a visitor", async () => {
      // Opaque UUIDs may coincidentally contain a short phone fragment. Inspect content fields, not entity/ref IDs.
      const audit = JSON.stringify((await q("SELECT action, entity_type, before, after, ip, user_agent FROM bb.audit_log")).rows);
      const outbox = JSON.stringify((await q("SELECT to_jsonb(o) - 'id' - 'ref_id' AS content FROM bb.outbox o")).rows);
      for (const secret of visitorNames) {
        assert.ok(!audit.includes(secret), "audit content must not contain a visitor name");
        assert.ok(!outbox.includes(secret), "outbox content must not contain a visitor name");
      }
      for (const fragment of visitorPhoneFragments) {
        assert.ok(!audit.includes(fragment), "audit content must not contain a visitor phone or its 8-digit suffix");
        assert.ok(!outbox.includes(fragment), "outbox content must not contain a visitor phone or its 8-digit suffix");
      }
    });
  });
});
