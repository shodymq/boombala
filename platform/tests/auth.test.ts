import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { authenticate, MAX_FAILURES_PER_EMAIL } from "../src/core/auth.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { hashPassword } from "../src/core/password.ts";
import { createSession, hashToken, revokeSession, SESSION_IDLE_SECONDS, validateSession } from "../src/core/session.ts";
import { changeOwnPassword, changeRole, createUser, listUsers, setActive, setPassword } from "../src/core/users.ts";
import { makeUser, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

describe("authentication, sessions and user management", () => {
  let db: TestDb;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  it("stores only an argon2id hash, never the password", async () => {
    const u = await makeUser(db.pool, "owner", "hash@example.test");
    const { rows } = await db.pool.query("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    assert.match(rows[0].password_hash, /^\$argon2id\$/);
    assert.ok(!rows[0].password_hash.includes(TEST_PASSWORD));
  });

  it("validates new users (password length, e-mail, role) and rejects duplicates", async () => {
    await assert.rejects(() => createUser(db.pool, null, { email: "bad", name: "x", role: "owner", password: TEST_PASSWORD }), ValidationError);
    await assert.rejects(() => createUser(db.pool, null, { email: "ok@example.test", name: "x", role: "owner", password: "short" }), ValidationError);
    await assert.rejects(() => createUser(db.pool, null, { email: "ok2@example.test", name: "x", role: "admin" as never, password: TEST_PASSWORD }), ValidationError);
    await makeUser(db.pool, "manager", "dup@example.test");
    await assert.rejects(() => makeUser(db.pool, "manager", "DUP@example.test"), ConflictError); // case-insensitive
  });

  it("logs in, creates a session whose raw token is not stored", async () => {
    const u = await makeUser(db.pool, "manager", "login@example.test");
    const res = await authenticate(db.pool, { email: " Login@Example.test ", password: TEST_PASSWORD, ip: "10.0.0.1" });
    assert.ok(res.ok);
    if (!res.ok) return;
    const stored = await db.pool.query("SELECT token_hash FROM sessions WHERE user_id = $1", [u.id]);
    assert.equal(stored.rows.length, 1);
    assert.deepEqual(stored.rows[0].token_hash, hashToken(res.token));
    assert.notEqual(stored.rows[0].token_hash.toString("base64url"), res.token);
    const session = await validateSession(db.pool, res.token);
    assert.equal(session?.user.email, "login@example.test");
    assert.equal(session?.user.role, "manager");
    const audit = await db.pool.query("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND actor_user_id = $1", [u.id]);
    assert.equal(audit.rowCount, 1);
  });

  it("answers identically for a wrong password, an unknown e-mail and a disabled account", async () => {
    const u = await makeUser(db.pool, "manager", "same@example.test");
    const wrong = await authenticate(db.pool, { email: "same@example.test", password: "wrong password 123", ip: "10.0.1.1" });
    const unknown = await authenticate(db.pool, { email: "nobody@example.test", password: TEST_PASSWORD, ip: "10.0.1.2" });
    assert.deepEqual(wrong, { ok: false, reason: "invalid" });
    assert.deepEqual(unknown, { ok: false, reason: "invalid" });
    await makeUser(db.pool, "owner", "boss@example.test");
    const boss = (await listUsers(db.pool, { id: (await db.pool.query("SELECT id FROM users WHERE email='boss@example.test'")).rows[0].id, role: "owner" })).find((x) => x.email === "same@example.test")!;
    await setActive(db.pool, { id: (await db.pool.query("SELECT id FROM users WHERE email='boss@example.test'")).rows[0].id, role: "owner" }, boss.id, false);
    const disabled = await authenticate(db.pool, { email: "same@example.test", password: TEST_PASSWORD, ip: "10.0.1.3" });
    assert.deepEqual(disabled, { ok: false, reason: "invalid" });
    assert.ok(u.id);
  });

  it("locks the account after repeated failures, even for the right password, and does not extend the lock", async () => {
    await makeUser(db.pool, "manager", "lock@example.test");
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      const r = await authenticate(db.pool, { email: "lock@example.test", password: "nope nope nope 1", ip: `10.1.0.${i}` });
      assert.deepEqual(r, { ok: false, reason: "invalid" });
    }
    const locked = await authenticate(db.pool, { email: "lock@example.test", password: TEST_PASSWORD, ip: "10.1.9.9" });
    assert.equal(locked.ok, false);
    assert.equal((locked as { reason: string }).reason, "locked");
    assert.ok((locked as { retryAfterSeconds: number }).retryAfterSeconds > 0);
    const before = (await db.pool.query("SELECT count(*)::int n FROM login_attempts WHERE email_norm = 'lock@example.test'")).rows[0].n;
    await authenticate(db.pool, { email: "lock@example.test", password: "x", ip: "10.1.9.9" });
    const after = (await db.pool.query("SELECT count(*)::int n FROM login_attempts WHERE email_norm = 'lock@example.test'")).rows[0].n;
    assert.equal(after, before, "attempts made while locked are not counted");
    // Expire the window: login works again and clears the counter.
    await db.pool.query("UPDATE login_attempts SET at = now() - interval '20 minutes' WHERE email_norm = 'lock@example.test'");
    const again = await authenticate(db.pool, { email: "lock@example.test", password: TEST_PASSWORD, ip: "10.1.9.9" });
    assert.ok(again.ok);
  });

  it("throttles one IP guessing many e-mails", async () => {
    for (let i = 0; i < 30; i++) await authenticate(db.pool, { email: `guess${i}@example.test`, password: "whatever 12345", ip: "203.0.113.5" });
    const r = await authenticate(db.pool, { email: "another@example.test", password: "whatever 12345", ip: "203.0.113.5" });
    assert.equal((r as { reason?: string }).reason, "locked");
    const other = await authenticate(db.pool, { email: "another@example.test", password: "whatever 12345", ip: "203.0.113.6" });
    assert.equal((other as { reason?: string }).reason, "invalid");
  });

  it("expires sessions by absolute time and by idle time, and can revoke them", async () => {
    const u = await makeUser(db.pool, "editor", "sess@example.test");
    const a = await createSession(db.pool, u.id);
    assert.ok(await validateSession(db.pool, a.token));
    await db.pool.query("UPDATE sessions SET last_seen_at = now() - make_interval(secs => $2) WHERE user_id = $1", [u.id, SESSION_IDLE_SECONDS + 5]);
    assert.equal(await validateSession(db.pool, a.token), null, "idle timeout");
    const b = await createSession(db.pool, u.id);
    await db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(b.token)]);
    assert.equal(await validateSession(db.pool, b.token), null, "absolute expiry");
    const c = await createSession(db.pool, u.id);
    await revokeSession(db.pool, c.token);
    assert.equal(await validateSession(db.pool, c.token), null, "revoked");
    assert.equal(await validateSession(db.pool, "not-a-token"), null);
    assert.equal(await validateSession(db.pool, undefined), null);
  });

  it("refreshes last_seen_at only when it is stale (saves writes)", async () => {
    const u = await makeUser(db.pool, "editor", "touch@example.test");
    const s = await createSession(db.pool, u.id);
    await db.pool.query("UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE user_id = $1", [u.id]);
    await validateSession(db.pool, s.token);
    const { rows } = await db.pool.query("SELECT last_seen_at > now() - interval '10 seconds' AS fresh FROM sessions WHERE user_id = $1", [u.id]);
    assert.equal(rows[0].fresh, true);
  });

  it("revokes sessions when the password or the role changes and when the user is disabled", async () => {
    const owner = await makeUser(db.pool, "owner", "root@example.test");
    const actor = { id: owner.id, role: "owner" as const };
    const u = await makeUser(db.pool, "manager", "rev@example.test");
    const s1 = await createSession(db.pool, u.id);
    const s2 = await createSession(db.pool, u.id);
    await setPassword(db.pool, actor, u.id, "another long password 42");
    assert.equal(await validateSession(db.pool, s1.token), null);
    assert.equal(await validateSession(db.pool, s2.token), null);
    const ok = await authenticate(db.pool, { email: "rev@example.test", password: "another long password 42", ip: "10.2.0.1" });
    assert.ok(ok.ok);
    if (!ok.ok) return;
    await changeRole(db.pool, actor, u.id, "editor");
    assert.equal(await validateSession(db.pool, ok.token), null, "role change signs the user out");
    const again = await authenticate(db.pool, { email: "rev@example.test", password: "another long password 42", ip: "10.2.0.2" });
    assert.ok(again.ok);
    if (!again.ok) return;
    await setActive(db.pool, actor, u.id, false);
    assert.equal(await validateSession(db.pool, again.token), null, "disabled user cannot use an old session");
    // self-service password change keeps the current device only
    const self = await createSession(db.pool, owner.id);
    const other = await createSession(db.pool, owner.id);
    const selfSession = await validateSession(db.pool, self.token);
    await setPassword(db.pool, actor, owner.id, "owner new password 99", { keepSessionId: selfSession!.sessionId });
    assert.ok(await validateSession(db.pool, self.token));
    assert.equal(await validateSession(db.pool, other.token), null);
  });

  it("self-service password change needs the current password and keeps only this device", async () => {
    const u = await makeUser(db.pool, "manager", "self@example.test");
    const actor = { id: u.id, role: "manager" as const };
    const here = await createSession(db.pool, u.id);
    const elsewhere = await createSession(db.pool, u.id);
    const current = await validateSession(db.pool, here.token);
    await assert.rejects(() => changeOwnPassword(db.pool, actor, "not my password", "a brand new password 1", { keepSessionId: current!.sessionId }), ValidationError);
    assert.ok(await validateSession(db.pool, elsewhere.token), "a failed attempt changes nothing");
    await assert.rejects(() => changeOwnPassword(db.pool, actor, TEST_PASSWORD, "short", { keepSessionId: current!.sessionId }), ValidationError);
    await changeOwnPassword(db.pool, actor, TEST_PASSWORD, "a brand new password 1", { keepSessionId: current!.sessionId });
    assert.ok(await validateSession(db.pool, here.token));
    assert.equal(await validateSession(db.pool, elsewhere.token), null);
    assert.ok((await authenticate(db.pool, { email: "self@example.test", password: "a brand new password 1", ip: "10.3.0.1" })).ok);
  });

  it("never leaves the system without an active Owner", async () => {
    const pool = db.pool;
    const only = await createUser(pool, null, { email: "solo@example.test", name: "Solo", role: "owner", password: TEST_PASSWORD });
    // other owners exist from earlier tests, so deactivate/demote them until one is left
    const owners = (await pool.query("SELECT id FROM users WHERE role='owner' AND is_active AND id <> $1", [only.id])).rows;
    for (const o of owners) await setActive(pool, { id: only.id, role: "owner" }, o.id, false);
    await assert.rejects(() => setActive(pool, { id: only.id, role: "owner" }, only.id, false), (e: Error) => e instanceof ConflictError && e.message === "last_owner");
    await assert.rejects(() => changeRole(pool, { id: only.id, role: "owner" }, only.id, "manager"), (e: Error) => e instanceof ConflictError && e.message === "last_owner");
  });

  it("non-owners cannot manage users", async () => {
    const mgr = await makeUser(db.pool, "manager", "m1@example.test");
    const actor = { id: mgr.id, role: "manager" as const };
    await assert.rejects(() => listUsers(db.pool, actor), ForbiddenError);
    await assert.rejects(() => createUser(db.pool, actor, { email: "x@example.test", name: "x", role: "owner", password: TEST_PASSWORD }), ForbiddenError);
    await assert.rejects(() => changeRole(db.pool, actor, mgr.id, "owner"), ForbiddenError);
    await assert.rejects(() => setActive(db.pool, actor, mgr.id, false), ForbiddenError);
    const victim = await makeUser(db.pool, "editor", "e9@example.test");
    await assert.rejects(() => setPassword(db.pool, actor, victim.id, "a new password 12345"), ForbiddenError);
    await setPassword(db.pool, actor, mgr.id, "my own new password 1"); // changing your own password is allowed
  });

  it("writes an audit trail for critical changes", async () => {
    const { rows } = await db.pool.query("SELECT DISTINCT action FROM audit_log ORDER BY action");
    const actions = rows.map((r) => r.action);
    for (const a of ["auth.login", "auth.login_failed", "user.created", "user.role_changed", "user.deactivated", "user.password_changed"]) {
      assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
    assert.ok(await hashPassword("x".repeat(12)));
  });
});
