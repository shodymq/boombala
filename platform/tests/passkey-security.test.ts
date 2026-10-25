import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { authenticate, completeMfaLogin } from "../src/core/auth.ts";
import { ConflictError, ForbiddenError } from "../src/core/errors.ts";
import { MAX_CODE_ATTEMPTS, generateEnrollmentCode, issueEnrollmentCode, issueEnrollmentCodeByEmail, normalizeEnrollmentCode, redeemEnrollmentCode } from "../src/core/enrollment.ts";
import { beginEnrollment, confirmEnrollment, resetUserMfa, resetUserMfaByEmail } from "../src/core/mfa.ts";
import type { PasskeyConfig } from "../src/core/passkey-config.ts";
import { beginLogin, beginRegistration, beginStepUp, finishLogin, finishRegistration, finishStepUp, listPasskeys, revokeAllPasskeys, revokePasskey } from "../src/core/passkeys.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { STEPUP_SECONDS, consumeStepUp, grantStepUp, hasStepUp, stepUpWithCode, type StepUpPurpose } from "../src/core/stepup.ts";
import { totpAt } from "../src/core/totp.ts";
import { TEST_PASSWORD, makeUser, startTestDb, stepUpProof, type TestDb } from "./helpers/db.ts";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator.ts";

const cfg: PasskeyConfig = { enabled: true, rpID: "admin.example.kz", rpName: "Boom Bala", origins: ["https://admin.example.kz"] };
const KEY = Buffer.alloc(32, 5).toString("base64");

describe("Passkeys: the security fixes (first enrolment, step-up, lockout, concurrency)", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let n = 0;
  const A = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });
  const device = (over: { userVerified?: boolean } = {}) => new VirtualAuthenticator({ rpID: cfg.rpID, origin: cfg.origins[0], ...over });
  const count = async (sql: string, p: unknown[] = []) => Number((await db.pool.query(sql, p)).rows[0].v);
  const staff = (role: "owner" | "manager" | "editor" = "manager") => makeUser(db.pool, role, `sec${++n}@example.test`);
  const ip = () => `10.88.${Math.floor(n / 200)}.${++n % 250}`;
  async function totp(user: { id: string }) {
    const e = await beginEnrollment(db.pool, user.id, KEY);
    await confirmEnrollment(db.pool, user.id, totpAt(e.secret, Date.now()), KEY);
    return e.secret;
  }
  async function sess(user: { id: string }, purpose?: StepUpPurpose) {
    const { token } = await createSession(db.pool, user.id, { ip: "10.77.0.5" }, "verified", { mfaVerified: true });
    const v = (await validateSession(db.pool, token))!;
    if (purpose) await grantStepUp(db.pool, { userId: user.id, sessionId: v.sessionId, purpose, method: "totp" });
    return { token, sessionId: v.sessionId, ctx: { ip: "10.77.0.5", userAgent: "t", sessionId: v.sessionId } };
  }
  async function addKey(user: { id: string; email: string; name: string }, a = device()) {
    const { ctx } = await sess(user, "passkey_register");
    const o = await beginRegistration(db.pool, cfg, user, ctx);
    return { a, passkey: await finishRegistration(db.pool, cfg, user, a.register(o), "dev", ctx) };
  }
  async function signIn(a: VirtualAuthenticator, over: Parameters<VirtualAuthenticator["assert"]>[1] = {}) {
    const i = ip();
    const o = await beginLogin(db.pool, cfg, {}, { ip: i });
    return finishLogin(db.pool, cfg, { response: a.assert(o, over) as never, ip: i });
  }
  const resetSteps = (u: { id: string }) => db.pool.query("UPDATE bb.user_mfa SET last_step = 0 WHERE user_id = $1", [u.id]);

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    await totp(owner);
  });
  after(async () => db.stop());

  describe("P0: nobody enrols a first factor with a password alone", () => {
    it("a new employee with only a password gets a pending session and can neither see the secret nor enrol", async () => {
      const u = await staff();
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      assert.ok(login.ok && login.mfa === "enroll");
      if (!login.ok) return;
      // the attacker has the password. The page would call beginEnrollment: without the code it does not (the gate); even if the secret existed,
      // the first code from it does not finish the sign-in:
      const e = await beginEnrollment(db.pool, u.id, KEY);
      const r = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: ip() });
      assert.equal(r.ok, false, "a valid code from the new secret is not enough without the Owner's code");
      assert.equal(await count("SELECT count(*) v FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NOT NULL", [u.id]), 0);
    });

    it("the Owner's one-time code opens enrolment for THAT session only, and works once", async () => {
      const u = await staff();
      const { code } = await issueEnrollmentCode(db.pool, A(owner), u.id);
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!login.ok) throw new Error("login");
      // typed in lower case, without dashes: the same code
      assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code: code.toLowerCase().replace(/-/g, ""), ip: ip() }), { ok: true });
      const e = await beginEnrollment(db.pool, u.id, KEY);
      const done = await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: ip() });
      assert.equal(done.ok, true);
      // the code is spent; another pending session of the same person cannot reuse it
      const again = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!again.ok) throw new Error("login");
      assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: again.token, code, ip: ip() }), { ok: false, reason: "invalid" });
    });

    it("only a hash is stored; a new code replaces the old one; an enrolled person gets none", async () => {
      const u = await staff();
      const first = await issueEnrollmentCode(db.pool, A(owner), u.id);
      const second = await issueEnrollmentCode(db.pool, A(owner), u.id);
      const stored = JSON.stringify((await db.pool.query("SELECT * FROM bb.enrollment_codes WHERE user_id = $1", [u.id])).rows);
      assert.ok(!stored.includes(first.code) && !stored.includes(second.code) && !stored.includes(normalizeEnrollmentCode(first.code)), "no clear code in the table");
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!login.ok) throw new Error("login");
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code: first.code, ip: ip() })).ok, false, "the replaced code is dead");
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code: second.code, ip: ip() })).ok, true);
      await assert.rejects(() => issueEnrollmentCode(db.pool, A(owner), owner.id), (e: unknown) => e instanceof ConflictError && e.message === "already_enrolled");
      const audit = JSON.stringify((await db.pool.query("SELECT after, before FROM bb.audit_log WHERE action LIKE 'enrollment.%'")).rows);
      assert.ok(!audit.includes(first.code) && !audit.includes(second.code), "the audit log never carries the code");
    });

    it("five wrong tries burn the code and are throttled like wrong passwords", async () => {
      const u = await staff();
      const { code } = await issueEnrollmentCode(db.pool, A(owner), u.id);
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: "10.99.0.1" });
      if (!login.ok) throw new Error("login");
      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code: generateEnrollmentCode(), ip: "10.99.0.1" })).ok, false);
      const r = await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code, ip: "10.99.0.1" });
      assert.equal(r.ok, false, "even the right code no longer works: it was burned (and the address is locked)");
      assert.ok((await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'enrollment.code_failed' AND actor_user_id = $1", [u.id])) >= MAX_CODE_ATTEMPTS);
    });

    it("an expired code is useless; a code is not for another person's session; a verified session cannot redeem", async () => {
      const u = await staff();
      const v = await staff();
      const { code } = await issueEnrollmentCode(db.pool, A(owner), u.id);
      const other = await authenticate(db.pool, { email: v.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!other.ok) throw new Error("login");
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: other.token, code, ip: ip() })).ok, false, "u's code in v's session");
      const verified = await sess(u);
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: verified.token, code, ip: ip() })).ok, false);
      await db.pool.query("UPDATE bb.enrollment_codes SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
      const mine = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!mine.ok) throw new Error("login");
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: mine.token, code, ip: ip() })).ok, false);
    });

    it("the server console can issue a code (audited, no actor), e.g. for an Owner who lost every device", async () => {
      const u = await staff("owner");
      const r = await issueEnrollmentCodeByEmail(db.pool, u.email.toUpperCase());
      assert.ok(r && /^[A-Z2-9-]{14}$/.test(r.code));
      assert.equal(await issueEnrollmentCodeByEmail(db.pool, "nobody@example.test"), null);
      const a = (await db.pool.query("SELECT actor_user_id, after FROM bb.audit_log WHERE action = 'enrollment.code_issued' AND entity_id = $1", [u.id])).rows[0];
      assert.equal(a.actor_user_id, null);
      assert.equal(a.after.via, "server_console");
    });

    it("only the Owner can issue a code", async () => {
      const m = await staff();
      const target = await staff();
      await assert.rejects(() => issueEnrollmentCode(db.pool, A(m), target.id), ForbiddenError);
    });
  });

  describe("P0: a reset means no trust: passkeys go too, and the way back is a NEW code", () => {
    it("after the Owner resets a person, their key is dead, their sessions end, and a password alone cannot enrol again", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      assert.equal((await signIn(a)).ok, true);
      await resetUserMfa(db.pool, A(owner), u.id, await stepUpProof(db.pool, owner));
      assert.equal((await listPasskeys(db.pool, u.id)).length, 0);
      assert.equal((await signIn(a)).ok, false, "the old key does not sign in");
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!login.ok) throw new Error("login");
      assert.equal(login.mfa, "enroll");
      const e = await beginEnrollment(db.pool, u.id, KEY);
      assert.equal((await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: ip() })).ok, false, "password alone: no");
    });

    it("the console reset is the same, and is audited with the keys it revoked", async () => {
      const u = await staff();
      await totp(u);
      await addKey(u);
      assert.equal(await resetUserMfaByEmail(db.pool, u.email), true);
      const a = (await db.pool.query("SELECT after FROM bb.audit_log WHERE action = 'mfa.reset' AND entity_id = $1", [u.id])).rows[0];
      assert.equal(a.after.passkeysRevoked, 1);
      assert.equal(a.after.via, "server_console");
    });
  });

  describe("P0: step-up before adding or revoking a key", () => {
    it("a signed-in cookie alone cannot add a device", async () => {
      const u = await staff();
      await totp(u);
      const s = await sess(u); // no step-up
      await assert.rejects(() => beginRegistration(db.pool, cfg, u, s.ctx), (e: unknown) => e instanceof ForbiddenError && e.message === "step_up_required");
      // and not even when the ceremony was started earlier (the challenge exists, the grant does not)
      const { ctx } = await sess(u, "passkey_register");
      const o = await beginRegistration(db.pool, cfg, u, ctx);
      await assert.rejects(() => finishRegistration(db.pool, cfg, u, device().register(o), "x", s.ctx), (e: unknown) => e instanceof ForbiddenError);
      assert.equal(await count("SELECT count(*) v FROM bb.passkeys WHERE user_id = $1", [u.id]), 0);
    });

    it("a passkey needs the authenticator app first (the backup that survives a lost phone)", async () => {
      const u = await staff();
      const { ctx } = await sess(u, "passkey_register");
      await assert.rejects(() => beginRegistration(db.pool, cfg, u, ctx), (e: unknown) => e instanceof ConflictError && e.message === "totp_required");
    });

    it("a grant is for one person, one session and one purpose, works once, and lapses", async () => {
      const u = await staff();
      const w = await staff();
      const s1 = await sess(u, "passkey_revoke");
      const s2 = await sess(u);
      assert.equal(await hasStepUp(db.pool, u.id, s2.sessionId, "passkey_revoke"), false, "another session of the same person");
      assert.equal(await hasStepUp(db.pool, u.id, s1.sessionId, "passkey_register"), false, "another purpose");
      assert.equal(await hasStepUp(db.pool, w.id, s1.sessionId, "passkey_revoke"), false, "another person");
      await consumeStepUp(db.pool, u.id, s1.sessionId, "passkey_revoke");
      await assert.rejects(() => consumeStepUp(db.pool, u.id, s1.sessionId, "passkey_revoke"), ForbiddenError, "single use");
      await grantStepUp(db.pool, { userId: u.id, sessionId: s1.sessionId, purpose: "passkey_revoke", method: "totp" });
      await db.pool.query("UPDATE bb.step_up_grants SET expires_at = now() - interval '1 second' WHERE session_id = $1", [s1.sessionId]);
      await assert.rejects(() => consumeStepUp(db.pool, u.id, s1.sessionId, "passkey_revoke"), ForbiddenError, "lapsed");
      assert.equal(STEPUP_SECONDS, 300);
    });

    it("two parallel requests with one grant: exactly one key is stored", async () => {
      const u = await staff();
      await totp(u);
      const { ctx } = await sess(u, "passkey_register");
      const o1 = await beginRegistration(db.pool, cfg, u, ctx);
      const o2 = await beginRegistration(db.pool, cfg, u, ctx);
      const r = await Promise.allSettled([finishRegistration(db.pool, cfg, u, device().register(o1), "a", ctx), finishRegistration(db.pool, cfg, u, device().register(o2), "b", ctx)]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal((await listPasskeys(db.pool, u.id)).length, 1);
    });

    it("revoking a key (own, another's, all of a person's) needs a grant", async () => {
      const u = await staff();
      await totp(u);
      const { passkey } = await addKey(u);
      const bare = await sess(u);
      await assert.rejects(() => revokePasskey(db.pool, A(u), passkey.id, bare.ctx), (e: unknown) => e instanceof ForbiddenError && e.message === "step_up_required");
      const ownerBare = await sess(owner);
      await assert.rejects(() => revokePasskey(db.pool, A(owner), passkey.id, ownerBare.ctx), ForbiddenError);
      await assert.rejects(() => revokeAllPasskeys(db.pool, A(owner), u.id, ownerBare.ctx), ForbiddenError, "mass revocation needs the Owner's step-up too");
      assert.equal((await listPasskeys(db.pool, u.id)).length, 1, "nothing was revoked");
    });

    it("step-up with a code: current code or recovery code; a wrong one is refused, audited and throttled; a code works once", async () => {
      const u = await staff();
      const secret = await totp(u);
      const s = await sess(u);
      const input = (code: string, i = "10.55.0.1") => ({ sessionToken: s.token, purpose: "passkey_register" as const, code, mfaKey: KEY, requireMfa: true, ip: i });
      assert.deepEqual(await stepUpWithCode(db.pool, input("000000")), { ok: false, reason: "invalid" });
      await resetSteps(u);
      const good = totpAt(secret, Date.now());
      assert.deepEqual(await stepUpWithCode(db.pool, input(good)), { ok: true, method: "totp" });
      assert.equal(await hasStepUp(db.pool, u.id, s.sessionId, "passkey_register"), true);
      assert.deepEqual(await stepUpWithCode(db.pool, input(good)), { ok: false, reason: "invalid" }, "the same code twice");
      assert.ok((await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'auth.stepup_failed' AND actor_user_id = $1", [u.id])) >= 2);
      for (let i = 0; i < 6; i++) await stepUpWithCode(db.pool, input("111111", "10.55.0.9"));
      assert.equal((await stepUpWithCode(db.pool, input(totpAt(secret, Date.now() + 30_000), "10.55.0.9"))).ok, false, "locked after repeated failures");
      assert.deepEqual(await stepUpWithCode(db.pool, { ...input("x"), sessionToken: "n".repeat(43) }), { ok: false, reason: "expired" });
    });

    it("step-up with a key: only the person's OWN key, only on the right origin", async () => {
      const u = await staff();
      await totp(u);
      const mine = (await addKey(u)).a;
      const other = await staff();
      await totp(other);
      const theirs = (await addKey(other)).a;
      const s = await sess(u);
      const base = { sessionToken: s.token, purpose: "passkey_revoke" as const, requireMfa: true };
      const go = async (a: VirtualAuthenticator, over: Parameters<VirtualAuthenticator["assert"]>[1] = {}) => {
        const o = await beginStepUp(db.pool, cfg, u, { ip: ip() });
        return finishStepUp(db.pool, cfg, { ...base, response: a.assert(o, over) as never, ip: ip() });
      };
      assert.equal((await go(theirs)).ok, false, "another person's key");
      assert.equal((await go(mine, { origin: "https://evil.example" })).ok, false);
      assert.equal(await hasStepUp(db.pool, u.id, s.sessionId, "passkey_revoke"), false);
      assert.equal((await go(mine)).ok, true);
      assert.equal(await hasStepUp(db.pool, u.id, s.sessionId, "passkey_revoke"), true);
    });
  });

  describe("P0: never lock a person out", () => {
    it("the last key cannot be revoked without a backup; with the app it can; the Owner cannot cut their own way in", async () => {
      const u = await staff();
      await totp(u);
      const { passkey } = await addKey(u);
      await db.pool.query("DELETE FROM bb.user_mfa WHERE user_id = $1", [u.id]); // break the invariant on purpose
      await assert.rejects(async () => revokePasskey(db.pool, A(u), passkey.id, (await sess(u, "passkey_revoke")).ctx), (e: unknown) => e instanceof ConflictError && e.message === "last_factor");
      await assert.rejects(async () => revokeAllPasskeys(db.pool, A({ ...u, role: "owner" }), u.id, (await sess(u, "passkeys_revoke_all")).ctx), ConflictError);
      assert.equal((await listPasskeys(db.pool, u.id)).length, 1, "still there");
      await totp(u);
      await revokePasskey(db.pool, A(u), passkey.id, (await sess(u, "passkey_revoke")).ctx);
      assert.equal((await listPasskeys(db.pool, u.id)).length, 0);
    });

    it("lost iPhone: a second device keeps working; the Owner revokes the lost one; with every device lost, the console code + a new enrolment brings the person back", async () => {
      const u = await staff();
      await totp(u);
      const phone = await addKey(u);
      const mac = await addKey(u);
      await revokePasskey(db.pool, A(owner), phone.passkey.id, (await sess(owner, "passkey_revoke")).ctx);
      assert.equal((await signIn(phone.a)).ok, false);
      assert.equal((await signIn(mac.a)).ok, true, "the Mac still works");
      // every device and the authenticator app lost: console reset, console code, new enrolment
      await resetUserMfaByEmail(db.pool, u.email);
      assert.equal((await signIn(mac.a)).ok, false);
      const c = await issueEnrollmentCodeByEmail(db.pool, u.email);
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!login.ok || !c) throw new Error("setup");
      assert.equal((await redeemEnrollmentCode(db.pool, { pendingToken: login.token, code: c.code, ip: ip() })).ok, true);
      const e = await beginEnrollment(db.pool, u.id, KEY);
      assert.equal((await completeMfaLogin(db.pool, { pendingToken: login.token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: ip() })).ok, true);
    });

    it("a disabled (dismissed) person's keys are dead and the Owner can wipe them", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      await db.pool.query("UPDATE bb.users SET is_active = false WHERE id = $1", [u.id]);
      assert.equal((await signIn(a)).ok, false);
      assert.equal(await revokeAllPasskeys(db.pool, A(owner), u.id, (await sess(owner, "passkeys_revoke_all")).ctx), 1);
    });
  });

  describe("WebAuthn: concurrency, replay and session handling", () => {
    it("the same answer sent twice at once: one session, not two", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      const i = ip();
      const o = await beginLogin(db.pool, cfg, {}, { ip: i });
      const answer = a.assert(o) as never;
      const r = await Promise.all([finishLogin(db.pool, cfg, { response: answer, ip: i }), finishLogin(db.pool, cfg, { response: answer, ip: i })]);
      assert.equal(r.filter((x) => x.ok).length, 1);
    });

    it("two different challenges answered with the SAME counter at once: the counter moves forward only once (a cloned key loses)", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      const o1 = await beginLogin(db.pool, cfg, {}, { ip: ip() });
      const o2 = await beginLogin(db.pool, cfg, {}, { ip: ip() });
      const x = a.assert(o1, { counter: 50 }) as never;
      const y = a.assert(o2, { counter: 50 }) as never;
      const r = await Promise.all([finishLogin(db.pool, cfg, { response: x, ip: ip() }), finishLogin(db.pool, cfg, { response: y, ip: ip() })]);
      assert.equal(r.filter((q) => q.ok).length, 1, "exactly one of the two");
      assert.equal(Number((await db.pool.query("SELECT counter v FROM bb.passkeys WHERE user_id = $1", [u.id])).rows[0].v), 50);
    });

    it("a key revoked after the options were issued and before the answer is refused", async () => {
      const u = await staff();
      await totp(u);
      const { a, passkey } = await addKey(u);
      const i = ip();
      const o = await beginLogin(db.pool, cfg, {}, { ip: i });
      const answer = a.assert(o) as never;
      await revokePasskey(db.pool, A(owner), passkey.id, (await sess(owner, "passkey_revoke")).ctx);
      assert.equal((await finishLogin(db.pool, cfg, { response: answer, ip: i })).ok, false);
    });

    it("a counter of 0 (Apple passkeys always report 0) keeps working", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      assert.equal((await signIn(a, { counter: 0 })).ok, true);
      assert.equal((await signIn(a, { counter: 0 })).ok, true);
    });

    it("a fresh session token every time: nothing the browser held before becomes a signed-in session (no fixation)", async () => {
      const u = await staff();
      await totp(u);
      const { a } = await addKey(u);
      const planted = "attacker-chosen-token-0123456789abcdefghijklmnop";
      assert.equal(await validateSession(db.pool, planted), null);
      const login = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, mfaRequired: true, ip: ip() });
      if (!login.ok) throw new Error("login");
      const i = ip();
      const o = await beginLogin(db.pool, cfg, { pendingUserId: u.id }, { ip: i });
      const r = await finishLogin(db.pool, cfg, { response: a.assert(o) as never, pendingToken: login.token, ip: i });
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.notEqual(r.token, login.token);
      assert.equal(await validateSession(db.pool, login.token, { state: "pending" }), null, "the pending token is dead");
      assert.equal(await validateSession(db.pool, planted), null);
    });

    it("several devices of one person all work; revoking the first leaves the second", async () => {
      const u = await staff();
      await totp(u);
      const one = await addKey(u);
      const two = await addKey(u);
      assert.equal((await signIn(one.a)).ok && (await signIn(two.a)).ok, true);
      await revokePasskey(db.pool, A(u), one.passkey.id, (await sess(u, "passkey_revoke")).ctx);
      assert.equal((await signIn(one.a)).ok, false);
      assert.equal((await signIn(two.a)).ok, true);
    });

    it("no credential id, public key or challenge ends up in the audit log", async () => {
      const dump = JSON.stringify((await db.pool.query("SELECT before, after, ip, user_agent FROM bb.audit_log")).rows);
      const ids = (await db.pool.query("SELECT credential_id FROM bb.passkeys LIMIT 20")).rows.map((r) => r.credential_id as string);
      assert.ok(ids.length > 0 && ids.every((id) => !dump.includes(id)));
    });
  });
});
