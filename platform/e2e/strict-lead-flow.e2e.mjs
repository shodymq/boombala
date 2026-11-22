/**
 * Isolated strict lead E2E: public site -> authenticated Platform intake -> disposable PostgreSQL -> CRM read model ->
 * production outbox worker -> local Telegram HTTP responder. No Production URL, database, credentials, or chat are used.
 * Run: `npm run e2e:strict-lead` from platform/ after npm ci in the root and platform apps.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { findFreePort, initCluster, startCluster, stopCluster } from "../scripts/lib/cluster.mjs";
import { syntheticPhone } from "../tests/helpers/synthetic-data.ts";

const platformDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(platformDir, "..");
for (const dir of [repoDir, platformDir]) {
  const envFiles = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"]
    .filter((name) => existsSync(join(dir, name)));
  if (envFiles.length) throw new Error("Refusing isolated E2E while app env files are present; run in a clean workspace.");
}

const work = mkdtempSync(join(tmpdir(), "bb-strict-lead-e2e-"));
const dataDir = join(work, "pgdata");
const pgPort = await findFreePort();
const apiPort = await findFreePort();
const sitePort = await findFreePort();
let socketDir;
let site;
let api;
let telegram;
const { Pool } = pg;
let ownerPool;
let apiPool;
let adminPool;
const procs = [];
const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG || "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
  NEXT_TELEMETRY_DISABLED: "1",
  NO_COLOR: "1",
};

function runNode(args, cwd, env) {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...baseEnv, ...env }, stdio: "ignore", timeout: 120_000 });
  if (r.error || r.status !== 0) throw new Error(`Isolated setup step failed (${args.at(-1)}; exit ${r.status ?? "spawn"}).`);
}

function startNext(cwd, port, env) {
  const nextBin = join(cwd, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd,
    env: { ...baseEnv, ...env },
    stdio: "ignore",
  });
  procs.push(child);
  return child;
}

async function waitHttp(url, host, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("An isolated Next.js process exited before its health check.");
    try {
      const response = await fetch(url, { headers: { host }, signal: AbortSignal.timeout(1000) });
      if (response.status > 0) return response;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("An isolated Next.js health check timed out.");
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    child.kill("SIGTERM");
  });
}

try {
  initCluster(dataDir);
  socketDir = startCluster(dataDir, pgPort, { fast: true });
  const ownerUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  ownerPool = new Pool({ connectionString: ownerUrl, max: 3 });

  runNode(["--conditions=react-server", "--no-warnings", "scripts/migrate.ts"], platformDir, { DATABASE_URL: ownerUrl });
  runNode(["--import", "./scripts/site-data-loader.mjs", "--conditions=react-server", "--no-warnings", "scripts/seed.ts"], platformDir, { DATABASE_URL: ownerUrl });

  const apiPassword = crypto.randomUUID() + crypto.randomUUID();
  const adminPassword = crypto.randomUUID() + crypto.randomUUID();
  runNode(["--no-warnings", "scripts/db-roles.ts"], platformDir, {
    DATABASE_URL: ownerUrl,
    BB_API_PASSWORD: apiPassword,
    BB_ADMIN_PASSWORD: adminPassword,
  });
  const apiUrl = `postgres://bb_api:${apiPassword}@127.0.0.1:${pgPort}/postgres`;
  const adminUrl = `postgres://bb_admin:${adminPassword}@127.0.0.1:${pgPort}/postgres`;
  apiPool = new Pool({ connectionString: apiUrl, max: 3 });
  adminPool = new Pool({ connectionString: adminUrl, max: 3 });
  await ownerPool.query(
    "INSERT INTO bb.legal_documents (kind,version,title,body,status,published_at) VALUES ('personal_data_consent',1,'Synthetic E2E consent','Synthetic fixture only.','published',now())",
  );

  const telegramMessages = [];
  telegram = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        telegramMessages.push(String(payload.text ?? ""));
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{"message_id":1}}');
      } catch {
        res.writeHead(400).end('{"ok":false}');
      }
    });
  });
  await new Promise((r) => telegram.listen(0, "127.0.0.1", r));
  const telegramPort = telegram.address().port;

  const token = crypto.randomUUID() + crypto.randomUUID();
  const pepper = crypto.randomUUID() + crypto.randomUUID();
  const apiHost = `127.0.0.1:${apiPort}`;
  api = startNext(platformDir, apiPort, {
    NODE_ENV: "development",
    PLATFORM_PROFILE: "kz-production",
    PLATFORM_ROLE: "api",
    PLATFORM_HTTPS: "1",
    ALLOWED_HOSTS: apiHost,
    DATABASE_URL: apiUrl,
    PLATFORM_INTAKE_TOKEN: token,
    PLATFORM_IP_PEPPER: pepper,
    PII_INTAKE_ENABLED: "1",
  });
  await waitHttp(`http://127.0.0.1:${apiPort}/api/health`, apiHost, api);

  site = startNext(repoDir, sitePort, {
    NODE_ENV: "development",
    SITE_PROFILE: "kz-production",
    NEXT_PUBLIC_SITE_PROFILE: "kz-production",
    LEAD_PIPELINE: "strict",
    PLATFORM_URL: `http://127.0.0.1:${apiPort}`,
    PLATFORM_INTAKE_TOKEN: token,
    NEXT_PUBLIC_SITE_URL: "https://boombala.kz",
  });
  await waitHttp(`http://127.0.0.1:${sitePort}/`, `127.0.0.1:${sitePort}`, site);

  const key = crypto.randomUUID();
  const leadInput = {
    idempotencyKey: key,
    name: "SYNTHETIC STRICT E2E",
    phone: syntheticPhone(),
    date: "2099-03-04",
    children: "3",
    package: "star-party",
    room: "ice-room",
    preferredStartTime: "15:00",
    consent: true,
    page: "/birthdays",
  };
  const submit = (body) => fetch(`http://127.0.0.1:${sitePort}/api/lead`, {
    method: "POST",
    headers: { "content-type": "application/json", host: `127.0.0.1:${sitePort}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const first = await submit(leadInput);
  const firstBody = await first.json().catch(() => ({}));
  const firstErrorCode = typeof firstBody.error === "string" && /^[a-z_]+$/.test(firstBody.error) ? firstBody.error : "unknown";
  assert.equal(first.status, 200, `the site strict route must report committed intake success (safe_error=${firstErrorCode})`);
  assert.deepEqual(firstBody, { ok: true });
  const repeated = await submit(leadInput);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { ok: true, duplicate: true });

  const persisted = (await ownerPool.query(
    "SELECT l.id,l.seq,l.package_id,l.slot_id,to_char(l.preferred_start_time,'HH24:MI') AS preferred_start_time,l.status,(SELECT count(*)::int FROM bb.outbox o WHERE o.ref_id=l.id AND o.topic='telegram.lead') AS outbox_count FROM bb.lead_requests l WHERE l.idempotency_key=$1",
    [key],
  )).rows[0];
  assert.deepEqual(
    { packageId: persisted.package_id, slotId: persisted.slot_id, preferredStartTime: persisted.preferred_start_time, status: persisted.status, outboxCount: Number(persisted.outbox_count) },
    { packageId: "star-party", slotId: null, preferredStartTime: "15:00", status: "new", outboxCount: 1 },
  );

  const { searchLeads, getLead } = await import("../src/core/lead-queue.ts");
  const actor = { id: crypto.randomUUID(), role: "owner" };
  const queue = await searchLeads(adminPool, actor, { q: "SYNTHETIC STRICT E2E" });
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].preferredStartTime, "15:00");
  const card = await getLead(adminPool, actor, persisted.id);
  assert.equal(card?.preferredStartTime, "15:00");

  const { drainOutbox } = await import("../src/core/outbox.ts");
  const { sendTelegram } = await import("../src/core/telegram.ts");
  const { notifyLevel } = await import("../src/server/notify-level.ts");
  const telegramConfig = { token: "synthetic-invalid-test-token", chatId: "synthetic-chat-id", apiBase: `http://127.0.0.1:${telegramPort}` };
  const delivered = await drainOutbox(adminPool, {
    level: notifyLevel({ PLATFORM_PROFILE: "kz-production", TELEGRAM_NOTIFY_LEVEL: "full" }),
    send: (text) => sendTelegram(telegramConfig, text, 3000),
    onlyRefId: persisted.id,
  });
  assert.deepEqual(delivered, { sent: 1, retry: 0, dead: 0 });
  assert.equal(telegramMessages.length, 1);
  const notification = telegramMessages[0];
  assert.match(notification, /CRM №\d+/);
  assert.match(notification, /Дата: 04\.03\.2099/);
  assert.match(notification, /Пакет: STAR PARTY/);
  assert.ok(!notification.includes("SYNTHETIC STRICT E2E"));
  assert.ok(!notification.includes(leadInput.phone));
  assert.ok(!notification.includes("15:00"), "all requested/customer details stay in the CRM");
  assert.equal((await ownerPool.query("SELECT status FROM bb.outbox WHERE ref_id=$1 AND topic='telegram.lead'", [persisted.id])).rows[0].status, "sent");
  await drainOutbox(adminPool, { level: "minimal", send: (text) => sendTelegram(telegramConfig, text, 3000), onlyRefId: persisted.id });
  assert.equal(telegramMessages.length, 1, "a sent task is not sent twice");

  const badTime = await submit({ ...leadInput, idempotencyKey: crypto.randomUUID(), preferredStartTime: "15:30" });
  assert.equal(badTime.status, 400);
  assert.equal((await badTime.json()).error, "validation");
  const badPackage = await submit({ ...leadInput, idempotencyKey: crypto.randomUUID(), package: "wow-party" });
  assert.equal(badPackage.status, 400, "retired package IDs are refused by the real Platform catalog, not silently remapped");
  assert.equal((await badPackage.json()).error, "validation");
  assert.equal(Number((await ownerPool.query("SELECT count(*)::int n FROM bb.lead_requests")).rows[0].n), 1, "invalid requests create no CRM rows");

  console.log("PASS strict site → Platform API (bb_api) → isolated PostgreSQL → CRM read model (bb_admin) → outbox worker → Telegram HTTP responder");
  console.log("PASS exact preferredStartTime=15:00, slot_id=NULL, package=star-party, idempotency, minimal non-PII notice, validation failures");
  console.log("LIMITATION no Production endpoint, database, secrets, or Telegram chat was used; real Telegram delivery requires the authorized Production release/GO.");
} finally {
  await Promise.all([stopProcess(site), stopProcess(api)]);
  if (telegram) await new Promise((r) => { telegram.closeAllConnections?.(); telegram.close(r); });
  await Promise.all([adminPool?.end(), apiPool?.end(), ownerPool?.end()].filter(Boolean));
  if (socketDir) stopCluster(dataDir, socketDir);
  rmSync(work, { recursive: true, force: true });
}
