import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { applyRoles } from "../scripts/db-roles.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import {
  createParentSession,
  lookupParentSession,
  newSessionId,
  ParentSessionInputError,
  revokeParentSession,
  rotateParentTokens,
  SessionSealer,
  sealerFromEnv,
  sessionHash,
} from "../src/core/parent-sessions.ts";
import { startTestDb, type TestDb } from "./helpers/db.ts";

const API_PW = "api-role-password-0123456789abc";
const ADMIN_PW = "admin-role-password-0123456789";
const SESSION_PW = "session-role-password-0123456789";
const KEY = randomBytes(32);

const ttl = 3600;
const later = () => new Date(Date.now() + 15 * 60_000);

describe("parent sessions: sealing", () => {
  const sealer = new SessionSealer(KEY);

  it("round-trips and never returns the plaintext in the sealed form", () => {
    const sealed = sealer.seal("access-token-value-123");
    assert.ok(!sealed.includes("access-token-value"));
    assert.equal(sealer.open(sealed), "access-token-value-123");
  });

  it("the same plaintext seals differently every time (random IV)", () => {
    assert.notEqual(sealer.seal("x"), sealer.seal("x"));
  });

  it("tampering is detected, not silently accepted", () => {
    const sealed = Buffer.from(sealer.seal("secret-token"), "base64url");
    sealed[sealed.length - 1] ^= 0x01;
    assert.throws(() => sealer.open(sealed.toString("base64url")));
  });

  it("a different key cannot open the value", () => {
    const other = new SessionSealer(randomBytes(32));
    assert.throws(() => other.open(sealer.seal("secret")));
  });

  it("the key comes from the environment and must be 32 random bytes", () => {
    assert.throws(() => sealerFromEnv({}), /32 random bytes/);
    assert.throws(() => sealerFromEnv({ PARENT_SESSION_ENC_KEY: "not-base64-!!" }), /32 random bytes/);
    assert.throws(() => sealerFromEnv({ PARENT_SESSION_ENC_KEY: randomBytes(16).toString("base64") }), /32 random bytes/);
    assert.ok(sealerFromEnv({ PARENT_SESSION_ENC_KEY: KEY.toString("base64") }).open(sealer.seal("ok")) === "ok");
  });

  it("the database key is a SHA-256 digest of the session id, never the id", () => {
    const sid = newSessionId();
    assert.equal(sessionHash(sid).length, 32);
    assert.ok(!sessionHash(sid).toString("utf8").includes(sid));
    assert.deepEqual(sessionHash(sid), sessionHash(sid));
  });
});

describe("parent sessions: storage in PostgreSQL with least privilege roles", () => {
  let db: TestDb;
  let owner: Pool;
  let session: Pool;
  let api: Pool;
  let admin: Pool;
  const sealer = new SessionSealer(KEY);
  const as = (user: string, password: string) => {
    const u = new URL(db.url);
    u.username = user;
    u.password = password;
    return createPool(u.toString(), { max: 2 });
  };

  before(async () => {
    db = await startTestDb();
    owner = db.pool;
    await applyRoles(owner, { apiPassword: API_PW, adminPassword: ADMIN_PW, sessionPassword: SESSION_PW });
    session = as("bb_session", SESSION_PW);
    api = as("bb_api", API_PW);
    admin = as("bb_admin", ADMIN_PW);
  });
  after(async () => {
    await session.end();
    await api.end();
    await admin.end();
    await db.stop();
  });

  it("create, lookup and read back the same tokens", async () => {
    const sid = newSessionId();
    await createParentSession(session, sealer, {
      sid, userId: "user-1", csrf: "csrf-A", access: "acc-A", refresh: "ref-A", accessExpiresAt: later(), ttlSeconds: ttl,
    });
    const got = await lookupParentSession(session, sealer, sid);
    assert.ok(got);
    assert.equal(got.userId, "user-1");
    assert.equal(got.csrf, "csrf-A");
    assert.equal(got.access, "acc-A");
    assert.equal(got.refresh, "ref-A");
  });

  it("the table holds no session id and no plaintext token", async () => {
    const sid = newSessionId();
    await createParentSession(session, sealer, {
      sid, userId: "user-2", csrf: "csrf-PLAIN", access: "acc-PLAIN", refresh: "ref-PLAIN", accessExpiresAt: later(), ttlSeconds: ttl,
    });
    const row = (await owner.query("SELECT * FROM bb.parent_sessions WHERE session_hash = $1", [sessionHash(sid)])).rows[0];
    const text = JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v));
    for (const secret of [sid, "csrf-PLAIN", "acc-PLAIN", "ref-PLAIN"]) assert.ok(!text.includes(secret), `stored in clear: ${secret}`);
  });

  it("an unknown session id is simply not found", async () => {
    assert.equal(await lookupParentSession(session, sealer, newSessionId()), null);
  });

  it("a session expires: expired rows are never returned", async () => {
    const sid = newSessionId();
    await createParentSession(session, sealer, { sid, userId: "u-exp", csrf: "c", access: "a", refresh: "r", accessExpiresAt: later(), ttlSeconds: ttl });
    // backdate the whole row (the table requires expires_at > created_at)
    await owner.query("UPDATE bb.parent_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE session_hash = $1", [sessionHash(sid)]);
    assert.equal(await lookupParentSession(session, sealer, sid), null);
  });

  it("refresh rotates the stored tokens; a revoked session cannot be rotated", async () => {
    const sid = newSessionId();
    await createParentSession(session, sealer, { sid, userId: "u-rot", csrf: "c", access: "a1", refresh: "r1", accessExpiresAt: later(), ttlSeconds: ttl });
    assert.equal(await rotateParentTokens(session, sealer, sid, { access: "a2", refresh: "r2", accessExpiresAt: later() }), true);
    const rotated = await lookupParentSession(session, sealer, sid);
    assert.equal(rotated?.refresh, "r2");
    await revokeParentSession(session, sid);
    assert.equal(await rotateParentTokens(session, sealer, sid, { access: "a3", refresh: "r3", accessExpiresAt: later() }), false);
  });

  it("revocation is immediate and idempotent", async () => {
    const sid = newSessionId();
    await createParentSession(session, sealer, { sid, userId: "u-rev", csrf: "c", access: "a", refresh: "r", accessExpiresAt: later(), ttlSeconds: ttl });
    await revokeParentSession(session, sid);
    assert.equal(await lookupParentSession(session, sealer, sid), null);
    await revokeParentSession(session, sid); // second time: no error
    await revokeParentSession(session, newSessionId()); // unknown id: no error
  });

  it("input is validated before it reaches the database", async () => {
    const base = { userId: "u", csrf: "c", access: "a", refresh: "r", accessExpiresAt: later() };
    await assert.rejects(createParentSession(session, sealer, { ...base, sid: "short", ttlSeconds: ttl }), ParentSessionInputError);
    await assert.rejects(createParentSession(session, sealer, { ...base, sid: newSessionId(), ttlSeconds: 10 }), ParentSessionInputError);
    await assert.rejects(createParentSession(session, sealer, { ...base, sid: newSessionId(), ttlSeconds: 10 * 24 * 3600 }), ParentSessionInputError);
  });

  it("the public API role cannot read or write parent sessions", async () => {
    await assert.rejects(() => api.query("SELECT 1 FROM bb.parent_sessions"), /permission denied/);
    await assert.rejects(() => api.query("INSERT INTO bb.parent_sessions (session_hash) VALUES ($1)", [randomBytes(32)]), /permission denied/);
  });

  it("the staff role cannot read parent sessions either (grants withheld and row security on)", async () => {
    await assert.rejects(() => admin.query("SELECT 1 FROM bb.parent_sessions"), /permission denied|row-level security/);
  });

  it("the session role cannot reach any other table", async () => {
    await assert.rejects(() => session.query("SELECT 1 FROM bb.users"), /permission denied|row-level security/);
    await assert.rejects(() => session.query("SELECT 1 FROM bb.audit_log"), /permission denied|row-level security/);
  });
});
