import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { authenticate, completeMfaLogin, MAX_FAILURES_PER_EMAIL } from "../src/core/auth.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/core/errors.ts";
import { beginEnrollment, isEnrolled, recoveryCodesLeft, resetUserMfa, resetUserMfaByEmail, verifySecondFactor } from "../src/core/mfa.ts";
import { can } from "../src/core/rbac.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { resetPasswordFromConsole } from "../src/core/users.ts";
import { totpAt } from "../src/core/totp.ts";
import { makeUser, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

const KEY = Buffer.alloc(32, 11).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 12).toString("base64");
const T0 = 1_800_000_000_000;

describe("Second factor (TOTP) for staff", () => {
  let db: TestDb;
  let n = 0;
  const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
  const scalar = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rows[0].v;

  /** Password step with the second factor mandatory. */
  const passwordStep = (email: string, ip = "10.77.0.5") => authenticate(db.pool, { email, password: TEST_PASSWORD, ip, userAgent: "T", mfaRequired: true });
  const newStaff = async (role: "owner" | "manager" | "editor") => makeUser(db.pool, role, `${role}${++n}@example.test`);

  /** A user who has completed enrolment; returns the secret, the recovery codes and a verified session token. */
  async function enrolled(role: "owner" | "manager" | "editor" = "manager") {
    const user = await newStaff(role);
    const login = await passwordStep(user.email);
    assert.ok(login.ok && login.mfa === "enroll");
    const e = await beginEnrollment(db.pool, user.id, KEY);
    const done = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e.secret, T0), mfaKey: KEY, ip: "10.77.0.5" }, T0);
    assert.ok(done.ok && done.recoveryCodes?.length === 10);
    return { user, secret: e.secret, recoveryCodes: done.recoveryCodes, token: done.token };
  }

  before(async () => {
    db = await startTestDb();
  });
  after(async () => db.stop());

  describe("the password alone is never enough", () => {
    it("a correct password gives only a PENDING session that the admin does not accept", async () => {
      const u = await newStaff("manager");
      const r = await passwordStep(u.email);
      assert.ok(r.ok && r.mfa === "enroll");
      assert.equal(await validateSession(db.pool, r.token), null, "not a usable admin session");
      assert.equal(await validateSession(db.pool, r.token, { state: "verified" }), null);
      assert.equal((await validateSession(db.pool, r.token, { state: "pending" }))?.user.id, u.id);
      assert.equal(await scalar("SELECT last_login_at IS NULL v FROM bb.users WHERE id = $1", [u.id]), true, "not counted as a login yet");
      // the pending session is short-lived
      const left = Number(await scalar("SELECT extract(epoch FROM (expires_at - now())) v FROM bb.sessions WHERE mfa_state = 'pending' ORDER BY created_at DESC LIMIT 1"));
      assert.ok(left > 0 && left <= 600);
    });

    it("without the mandatory mode nothing changes: the password gives a normal session", async () => {
      const u = await newStaff("editor");
      const r = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, ip: "10.77.0.5" });
      assert.ok(r.ok && r.mfa === "none");
      assert.equal((await validateSession(db.pool, r.token))?.user.role, "editor");
    });

    it("a wrong password never reaches the second step", async () => {
      const u = await newStaff("manager");
      const r = await authenticate(db.pool, { email: u.email, password: "wrong wrong wrong", ip: "10.77.0.6", mfaRequired: true });
      assert.deepEqual(r, { ok: false, reason: "invalid" });
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.sessions WHERE user_id = $1", [u.id]), 0);
    });
  });

  describe("enrolment", () => {
    it("first login: shows the secret, refuses a wrong code, accepts the right one, returns 10 recovery codes once and swaps the session", async () => {
      const u = await newStaff("owner");
      const login = await passwordStep(u.email);
      assert.ok(login.ok);
      const e1 = await beginEnrollment(db.pool, u.id, KEY);
      const e2 = await beginEnrollment(db.pool, u.id, KEY);
      assert.equal(e1.secret, e2.secret, "a refresh shows the same secret");
      assert.ok(e1.otpauth.startsWith("otpauth://totp/"));
      assert.ok(!(await scalar("SELECT secret_enc v FROM bb.user_mfa WHERE user_id = $1", [u.id])).includes(e1.secret), "stored encrypted");

      const bad = await completeMfaLogin(db.pool, { pendingToken: login.token, code: "000000", mfaKey: KEY, ip: "10.77.0.5" }, T0);
      assert.deepEqual(bad, { ok: false, reason: "invalid" });
      assert.equal(await isEnrolled(db.pool, u.id), false);

      const ok = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e1.secret, T0), mfaKey: KEY, ip: "10.77.0.5", userAgent: "T" }, T0);
      assert.ok(ok.ok);
      assert.equal(ok.recoveryCodes?.length, 10);
      assert.notEqual(ok.token, login.token, "the session token changes");
      assert.equal(await validateSession(db.pool, login.token, { state: "pending" }), null, "the pending session is gone");
      assert.equal((await validateSession(db.pool, ok.token))?.user.role, "owner", "RBAC role is unchanged");
      assert.equal(await isEnrolled(db.pool, u.id), true);
      assert.equal(await recoveryCodesLeft(db.pool, u.id), 10);
      assert.ok(!(await q("SELECT code_hash FROM bb.mfa_recovery_codes WHERE user_id = $1", [u.id])).rows.some((r) => ok.recoveryCodes!.some((c) => Buffer.from(r.code_hash).toString("utf8").includes(c))));
      await assert.rejects(() => beginEnrollment(db.pool, u.id, KEY), ConflictError);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'mfa.enrolled' AND entity_id = $1", [u.id]), 1);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'auth.login' AND entity_id = $1", [u.id]), 1, "one login is recorded, at the end");
    });

    it("the audit log and the database never hold the secret or a recovery code in clear", async () => {
      const x = await enrolled("manager");
      const dump = JSON.stringify([(await q("SELECT * FROM bb.user_mfa")).rows, (await q("SELECT code_hash FROM bb.mfa_recovery_codes")).rows, (await q("SELECT before, after FROM bb.audit_log")).rows]);
      assert.ok(!dump.includes(x.secret));
      for (const c of x.recoveryCodes) assert.ok(!dump.includes(c) && !dump.includes(c.replace("-", "")));
    });
  });

  describe("later logins", () => {
    it("a current code opens the session; the same code cannot be used twice (replay); the next time step works", async () => {
      const x = await enrolled();
      const login = await passwordStep(x.user.email);
      assert.ok(login.ok && login.mfa === "verify");
      // the enrolment already used the code of step T0
      const replay = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(x.secret, T0), mfaKey: KEY, ip: "10.77.0.5" }, T0);
      assert.deepEqual(replay, { ok: false, reason: "invalid" });
      const next = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(x.secret, T0 + 30_000), mfaKey: KEY, ip: "10.77.0.5" }, T0 + 30_000);
      assert.ok(next.ok);
      assert.equal((await validateSession(db.pool, next.token))?.user.id, x.user.id);
      assert.equal(next.recoveryCodes, undefined, "recovery codes are shown only at enrolment");
      const again = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(x.secret, T0 + 60_000), mfaKey: KEY, ip: "10.77.0.5" }, T0 + 60_000);
      assert.deepEqual(again, { ok: false, reason: "expired" }, "a used pending session cannot be used again");
    });

    it("wrong codes are throttled together with wrong passwords, and a lock also stops the right code", async () => {
      const x = await enrolled();
      const login = await passwordStep(x.user.email, "10.77.0.9");
      assert.ok(login.ok);
      for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
        assert.deepEqual(await completeMfaLogin(db.pool, { pendingToken: login.token, code: "111111", mfaKey: KEY, ip: "10.77.0.9" }, T0 + 90_000), { ok: false, reason: "invalid" });
      }
      const locked = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(x.secret, T0 + 120_000), mfaKey: KEY, ip: "10.77.0.9" }, T0 + 120_000);
      assert.ok(!locked.ok && locked.reason === "locked");
      assert.ok((await passwordStep(x.user.email, "10.77.0.9")).ok === false, "the password step is locked too");
    });

    it("a recovery code works once, is consumed, and is recorded", async () => {
      const x = await enrolled();
      const [first, second] = x.recoveryCodes;
      const login = await passwordStep(x.user.email, "10.77.0.20");
      assert.ok(login.ok);
      const ok = await completeMfaLogin(db.pool, { pendingToken: login.token, code: first.toLowerCase().replace("-", " "), mfaKey: KEY, ip: "10.77.0.20" }, T0);
      assert.ok(ok.ok);
      assert.equal(await recoveryCodesLeft(db.pool, x.user.id), 9);
      assert.equal(await scalar("SELECT (after->>'left')::int v FROM bb.audit_log WHERE action = 'mfa.recovery_used' AND entity_id = $1", [x.user.id]), 9);
      const login2 = await passwordStep(x.user.email, "10.77.0.21");
      assert.ok(login2.ok);
      assert.deepEqual(await completeMfaLogin(db.pool, { pendingToken: login2.token, code: first, mfaKey: KEY, ip: "10.77.0.21" }, T0), { ok: false, reason: "invalid" }, "the used code is dead");
      assert.ok((await completeMfaLogin(db.pool, { pendingToken: login2.token, code: second, mfaKey: KEY, ip: "10.77.0.21" }, T0)).ok);
    });

    it("a pending session that expired, or whose user was disabled meanwhile, cannot finish", async () => {
      const x = await enrolled();
      const login = await passwordStep(x.user.email, "10.77.0.30");
      assert.ok(login.ok);
      await q("UPDATE bb.sessions SET expires_at = now() - interval '1 second' WHERE mfa_state = 'pending' AND user_id = $1", [x.user.id]);
      assert.deepEqual(await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(x.secret, T0 + 150_000), mfaKey: KEY, ip: "10.77.0.30" }, T0 + 150_000), { ok: false, reason: "expired" });
      const y = await enrolled();
      const l2 = await passwordStep(y.user.email, "10.77.0.31");
      assert.ok(l2.ok);
      await q("UPDATE bb.users SET is_active = false WHERE id = $1", [y.user.id]);
      assert.deepEqual(await completeMfaLogin(db.pool, { pendingToken: l2.token, code: totpAt(y.secret, T0 + 150_000), mfaKey: KEY, ip: "10.77.0.31" }, T0 + 150_000), { ok: false, reason: "expired" });
    });

    it("a garbage or missing token cannot start the second step", async () => {
      for (const t of [undefined, "", "x".repeat(40)]) assert.deepEqual(await completeMfaLogin(db.pool, { pendingToken: t, code: "123456", mfaKey: KEY }, T0), { ok: false, reason: "expired" });
    });

    it("a secret sealed with another key never verifies (and does not crash into a login)", async () => {
      const x = await enrolled();
      await assert.rejects(() => verifySecondFactor(db.pool, x.user.id, totpAt(x.secret, T0 + 200_000), OTHER_KEY, {}, T0 + 200_000));
    });
  });

  describe("policy switched on after sessions already existed", () => {
    it("a verified session of someone without a second factor is refused when the factor is mandatory", async () => {
      const u = await newStaff("manager");
      const legacy = await createSession(db.pool, u.id, { ip: "10.77.0.40" });
      assert.ok(await validateSession(db.pool, legacy.token), "accepted while the policy is off");
      assert.equal(await validateSession(db.pool, legacy.token, { requireEnrolled: true }), null, "refused once it is mandatory");
      const x = await enrolled();
      assert.ok(await validateSession(db.pool, x.token, { requireEnrolled: true }), "an enrolled user's session stays valid");
    });
  });

  describe("reset: lost phone", () => {
    it("the Owner removes another person's factor: sessions end, codes die, it is audited, and they enrol again", async () => {
      const owner = await newStaff("owner");
      const x = await enrolled("manager");
      await resetUserMfa(db.pool, { id: owner.id, role: "owner" }, x.user.id, { ip: "10.77.0.1" });
      assert.equal(await isEnrolled(db.pool, x.user.id), false);
      assert.equal(await validateSession(db.pool, x.token), null, "their session ended");
      assert.equal(await recoveryCodesLeft(db.pool, x.user.id), 0);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'mfa.reset' AND entity_id = $1 AND actor_user_id = $2", [x.user.id, owner.id]), 1);
      const again = await passwordStep(x.user.email, "10.77.0.50");
      assert.ok(again.ok && again.mfa === "enroll");
    });

    it("nobody else may reset, and the Owner cannot reset their own factor", async () => {
      const owner = await newStaff("owner");
      const x = await enrolled("editor");
      for (const role of ["manager", "editor"] as const) await assert.rejects(() => resetUserMfa(db.pool, { id: x.user.id, role }, owner.id), ForbiddenError);
      await assert.rejects(() => resetUserMfa(db.pool, { id: owner.id, role: "owner" }, owner.id), ValidationError);
      await assert.rejects(() => resetUserMfa(db.pool, { id: owner.id, role: "owner" }, "00000000-0000-0000-0000-000000000000"), NotFoundError);
      await assert.rejects(() => resetUserMfa(db.pool, { id: owner.id, role: "owner" }, "not-an-id"), NotFoundError);
      assert.equal(await isEnrolled(db.pool, x.user.id), true);
    });

    it("break-glass from the server console: works by e-mail, audited with no actor, unknown e-mail is reported", async () => {
      const x = await enrolled("owner");
      assert.equal(await resetUserMfaByEmail(db.pool, x.user.email.toUpperCase()), true);
      assert.equal(await isEnrolled(db.pool, x.user.id), false);
      assert.equal(await validateSession(db.pool, x.token), null);
      assert.equal(await scalar("SELECT after->>'via' v FROM bb.audit_log WHERE action = 'mfa.reset' AND entity_id = $1", [x.user.id]), "server_console");
      assert.equal(await resetUserMfaByEmail(db.pool, "nobody@example.test"), false);
    });
  });

  describe("break-glass: a locked-out Owner gets back in from the server console", () => {
    it("sets a new password by e-mail, ends every session, is audited as the console, refuses a weak password, reports an unknown e-mail", async () => {
      const x = await enrolled("owner");
      assert.equal(await resetPasswordFromConsole(db.pool, x.user.email.toUpperCase(), "a brand new long password"), true);
      assert.equal(await validateSession(db.pool, x.token), null, "their sessions ended");
      assert.deepEqual(await authenticate(db.pool, { email: x.user.email, password: TEST_PASSWORD, ip: "10.77.0.60" }), { ok: false, reason: "invalid" });
      const again = await authenticate(db.pool, { email: x.user.email, password: "a brand new long password", ip: "10.77.0.61", mfaRequired: true });
      assert.ok(again.ok && again.mfa === "verify", "the new password works and the second factor is still required");
      assert.equal(await scalar("SELECT after->>'via' v FROM bb.audit_log WHERE action = 'user.password_changed' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [x.user.id]), "server_console");
      await assert.rejects(() => resetPasswordFromConsole(db.pool, x.user.email, "short"), ValidationError);
      assert.equal(await resetPasswordFromConsole(db.pool, "nobody@example.test", "a brand new long password"), false);
    });
  });

  describe("roles inside the second factor", () => {
    it("RBAC is the same for the three roles after a second-factor login", async () => {
      for (const role of ["owner", "manager", "editor"] as const) {
        const x = await enrolled(role);
        const s = await validateSession(db.pool, x.token, { requireEnrolled: true });
        assert.equal(s?.user.role, role);
        assert.equal(can(role, "users.manage"), role === "owner");
        assert.equal(can(role, "contacts.view"), role !== "editor");
        assert.equal(can(role, "news.manage"), role !== "manager");
      }
    });
  });
});
