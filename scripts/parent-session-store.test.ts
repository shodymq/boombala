/**
 * The site's side of the shared parent sessions: the platform HTTP client against a fake platform (same contract as
 * platform/src/server/parent-sessions.ts), and the sealed pending login cookie. No database, no network beyond loopback.
 *
 *   npm run test:parent-store
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { platformSessionStore, MemorySessionStore } from "../src/lib/parent/session-store.ts";
import { SessionStoreUnavailable, type SessionRecord } from "../src/lib/parent/core.ts";
import { PendingSealer, pendingSealerFromEnv } from "../src/lib/parent/pending.ts";

const TOKEN = "service-token-0123456789abcdef";
const SID = randomBytes(32).toString("base64url");
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  userId: "user-1",
  csrf: "csrf-SECRET-1",
  access: "access-SECRET-1",
  refresh: "refresh-SECRET-1",
  accessExpiresAt: Date.now() + 900_000,
  ...over,
});

/** A fake platform. `mode` lets a test simulate outages and malformed answers. */
function fakePlatform(opts: { mode?: "ok" | "down" | "malformed" | "slow" } = {}) {
  const rows = new Map<string, SessionRecord & { revoked: boolean }>();
  const seen: Array<{ path: string; auth: string | null; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    };
    if (opts.mode === "down") return send(503, { ok: false, error: "unavailable" });
    if (opts.mode === "slow") return setTimeout(() => send(200, { ok: true }), 1500);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: "unauthorized" });
    const b = JSON.parse(body || "{}") as Record<string, unknown>;
    const sid = String(b.sid ?? "");
    const action = String(req.url ?? "").split("/").pop();
    if (opts.mode === "malformed") return send(200, "{not json");
    if (action === "create") {
      rows.set(sid, { userId: String(b.userId), csrf: String(b.csrf), access: String(b.access), refresh: String(b.refresh), accessExpiresAt: Number(b.accessExpiresAt), revoked: false });
      return send(201, { ok: true });
    }
    const row = rows.get(sid);
    if (action === "lookup") return row && !row.revoked ? send(200, { ok: true, session: { userId: row.userId, csrf: row.csrf, access: row.access, refresh: row.refresh, accessExpiresAt: row.accessExpiresAt } }) : send(404, { ok: false, error: "not_found" });
    if (action === "rotate") {
      if (!row || row.revoked) return send(404, { ok: false, error: "not_found" });
      Object.assign(row, { access: b.access, refresh: b.refresh, accessExpiresAt: b.accessExpiresAt });
      return send(200, { ok: true });
    }
    if (action === "revoke") {
      if (row) row.revoked = true;
      return send(200, { ok: true });
    }
    return send(404, { ok: false });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test("create, lookup, rotate and revoke through the platform", async () => {
  const fake = await fakePlatform();
  try {
    const store = platformSessionStore({ baseUrl: fake.url, token: TOKEN });
    const original = record();
    await store.create(SID, original, 3600);
    assert.deepEqual(await store.lookup(SID), original);
    assert.equal(await store.rotate(SID, { access: "a2", refresh: "r2", accessExpiresAt: 1 }), true);
    assert.equal((await store.lookup(SID))?.refresh, "r2");
    await store.revoke(SID);
    assert.equal(await store.lookup(SID), null);
    assert.equal(await store.rotate(SID, { access: "a3", refresh: "r3", accessExpiresAt: 1 }), false);
  } finally {
    await fake.close();
  }
});

test("the bearer token travels in the header, never in the URL or the body of the lookup", async () => {
  const fake = await fakePlatform();
  try {
    const store = platformSessionStore({ baseUrl: fake.url, token: TOKEN });
    await store.create(SID, record(), 3600);
    await store.lookup(SID);
    for (const call of fake.seen) {
      assert.equal(call.auth, `Bearer ${TOKEN}`);
      assert.ok(!call.path.includes(TOKEN) && !call.path.includes(SID), "no secret in the URL");
    }
    assert.ok(!fake.seen.find((c) => c.path.endsWith("/lookup"))?.body.includes(TOKEN));
  } finally {
    await fake.close();
  }
});

test("a wrong service token is unavailable, never 'no session'", async () => {
  const fake = await fakePlatform();
  try {
    const store = platformSessionStore({ baseUrl: fake.url, token: "a-different-token-0123456789" });
    await assert.rejects(store.lookup(SID), SessionStoreUnavailable);
  } finally {
    await fake.close();
  }
});

test("platform down, malformed answer and timeout are all unavailable (fail closed)", async () => {
  const down = await fakePlatform({ mode: "down" });
  const bad = await fakePlatform({ mode: "malformed" });
  const slow = await fakePlatform({ mode: "slow" });
  try {
    await assert.rejects(platformSessionStore({ baseUrl: down.url, token: TOKEN }).lookup(SID), SessionStoreUnavailable);
    await assert.rejects(platformSessionStore({ baseUrl: bad.url, token: TOKEN }).lookup(SID), SessionStoreUnavailable);
    await assert.rejects(platformSessionStore({ baseUrl: slow.url, token: TOKEN, timeoutMs: 200 }).lookup(SID), SessionStoreUnavailable);
  } finally {
    await down.close();
    await bad.close();
    await slow.close();
  }
});

test("an unreachable platform is unavailable and the error names no URL or token", async () => {
  const store = platformSessionStore({ baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 500 });
  await assert.rejects(store.lookup(SID), (e: unknown) => {
    const text = `${(e as Error).name} ${(e as Error).message}`;
    return e instanceof SessionStoreUnavailable && !text.includes("127.0.0.1") && !text.includes(TOKEN);
  });
});

test("two processes share one store: a session created by one is seen by the other", async () => {
  const fake = await fakePlatform();
  try {
    const processA = platformSessionStore({ baseUrl: fake.url, token: TOKEN });
    const processB = platformSessionStore({ baseUrl: fake.url, token: TOKEN });
    await processA.create(SID, record({ userId: "shared-user" }), 3600);
    assert.equal((await processB.lookup(SID))?.userId, "shared-user");
  } finally {
    await fake.close();
  }
});

test("the memory store is for tests: it honours the same contract", async () => {
  let t = 0;
  const m = new MemorySessionStore(() => t);
  await m.create(SID, record(), 60);
  assert.ok(await m.lookup(SID));
  t = 61_000;
  assert.equal(await m.lookup(SID), null, "expired");
});

// ── Sealed pending login cookie ─────────────────────────────────────────────────────────────────────

test("pending login: sealed, round-trips, and the phone is not visible in the cookie value", () => {
  const sealer = new PendingSealer(randomBytes(32));
  const value = sealer.seal({ phone: "+77071234567", verificationId: "otp_abc", expiresAt: Date.now() + 60_000 });
  assert.ok(!value.includes("77071234567") && !value.includes("otp_abc"));
  assert.equal(sealer.open(value)?.phone, "+77071234567");
});

test("pending login: expired, forged, empty or wrong-key values are refused", () => {
  const key = randomBytes(32);
  const sealer = new PendingSealer(key);
  const expired = sealer.seal({ phone: "+77071234567", verificationId: "v", expiresAt: 1000 });
  assert.equal(sealer.open(expired, 2000), null);
  const good = sealer.seal({ phone: "+77071234567", verificationId: "v", expiresAt: Date.now() + 60_000 });
  const forged = Buffer.from(good, "base64url");
  forged[forged.length - 2] ^= 0x10;
  assert.equal(sealer.open(forged.toString("base64url")), null);
  assert.equal(new PendingSealer(randomBytes(32)).open(good), null);
  assert.equal(sealer.open(undefined), null);
  assert.equal(sealer.open("x".repeat(3000)), null);
});

test("pending key: 32 random bytes from the environment, otherwise refused", () => {
  assert.throws(() => pendingSealerFromEnv({}), /32 random bytes/);
  assert.throws(() => pendingSealerFromEnv({ PARENT_PENDING_KEY: Buffer.alloc(8).toString("base64") }), /32 random bytes/);
  assert.ok(pendingSealerFromEnv({ PARENT_PENDING_KEY: randomBytes(32).toString("base64") }));
});
