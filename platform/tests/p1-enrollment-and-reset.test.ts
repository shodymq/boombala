import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { authenticate, completeMfaLogin } from "../src/core/auth.ts";
import { ConflictError, ForbiddenError } from "../src/core/errors.ts";
import { enrollmentGateActive, issueEnrollmentCode, mayEnroll, offerEnrollment, redeemEnrollmentCode } from "../src/core/enrollment.ts";
import { migrate } from "../src/core/migrate.ts";
import { beginEnrollment, confirmEnrollment, isEnrolled, resetUserMfa, resetUserMfaByEmail } from "../src/core/mfa.ts";
import { preflight } from "../src/core/preflight.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { grantStepUp, hasStepUp } from "../src/core/stepup.ts";
import { totpAt } from "../src/core/totp.ts";
import { makeUser, MIGRATIONS_DIR, startTestDb, stepUpProof, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

/**
 * Two P1 findings from the independent review of PR #30, with their negative tests:
 *  P1-1  TOTP enrolment was fail-open on a database without migration 014 (any password was enough to enrol a phone).
 *  P1-2  The Owner could reset another person's second factor with a plain session (no fresh step-up).
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const OWNER_IP = "10.77.0.5";

/** A pending session after the password, exactly as the login does it. */
async function pendingFor(pool: TestDb["pool"], email: string) {
  const login = await authenticate(pool, { email, password: TEST_PASSWORD, mfaRequired: true, ip: OWNER_IP });
  if (!login.ok || login.mfa !== "enroll") throw new Error("expected a pending enrolment session");
  const pending = await validateSession(pool, login.token, { state: "pending" });
  if (!pending) throw new Error("no pending session");
  return { token: login.token, pending };
}

describe("P1-1: first-factor enrolment is fail-closed without migration 014", () => {
  let db: TestDb;
  let legacyDir: string;

  before(async () => {
    // A database that only has migrations 001..013 (the running production state before this release).
    legacyDir = mkdtempSync(join(tmpdir(), "bb-legacy-"));
    for (const f of readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 13) copyFileSync(join(MIGRATIONS_DIR, f), join(legacyDir, f));
    db = await startTestDb({ migrate: false });
    await migrate(db.pool, legacyDir);
  });
  after(async () => {
    await db.stop();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("a database with 001..013 has no enrolment gate and is refused every enrolment step", async () => {
    assert.equal(await enrollmentGateActive(db.pool), false);
    const u = await makeUser(db.pool, "manager", "legacy.manager@example.test");
    const { token, pending } = await pendingFor(db.pool, u.email);

    assert.equal(await mayEnroll(db.pool, pending), false, "mayEnroll is fail-closed");
    assert.equal(await mayEnroll(db.pool, { sessionId: pending.sessionId, enrollAuthorizedAt: new Date() }), false, "even a 'redeemed' flag cannot open it");
    await assert.rejects(() => issueEnrollmentCode(db.pool, { id: u.id, role: "owner" }, u.id), ConflictError, "no code can be issued");
    const r = await redeemEnrollmentCode(db.pool, { pendingToken: token, code: "ABCD-EFGH-JKLM" });
    assert.deepEqual(r, { ok: false, reason: "invalid" }, "a redemption is refused, not an SQL error");
  });

  it("the TOTP secret is not revealed (no secret is created, none is offered)", async () => {
    const u = await makeUser(db.pool, "editor", "legacy.editor@example.test");
    const { pending } = await pendingFor(db.pool, u.email);
    assert.equal(await offerEnrollment(db.pool, pending, KEY), null, "the login page gets no secret");
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM bb.user_mfa WHERE user_id = $1", [u.id]);
    assert.equal(rows.rows[0].n, 0, "no pending secret was written");
  });

  it("completeMfaLogin rejects a first enrolment even with a correct TOTP of an existing secret", async () => {
    const u = await makeUser(db.pool, "manager", "legacy.attacker@example.test");
    const { token } = await pendingFor(db.pool, u.email);
    // Worst case: a row with a secret exists (e.g. written by an older path). The code is still correct, and still refused.
    const e = await beginEnrollment(db.pool, u.id, KEY);
    const result = await completeMfaLogin(db.pool, { pendingToken: token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: OWNER_IP });
    assert.deepEqual(result, { ok: false, reason: "invalid" });
    assert.equal(await isEnrolled(db.pool, u.id), false, "the phone was not enrolled");
  });

  it("preflight fails on a database without migration 014, even though passkeys are not in use", async () => {
    const withoutDir = await preflight(db.pool);
    assert.equal(withoutDir.ok, false);
    assert.ok(withoutDir.problems.some((p) => p.startsWith("migration_014_missing")), withoutDir.problems.join(", "));
    const withDir = await preflight(db.pool, MIGRATIONS_DIR);
    assert.ok(withDir.problems.some((p) => p.includes("014_passkeys.sql")), "the file-level check names the migration too");
  });
});

describe("P1-1: with migration 014, first enrolment works only with a valid Owner code", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner", "gate.owner@example.test");
  });
  after(async () => db.stop());

  it("preflight reports no migration problem on the full set of migrations", async () => {
    const r = await preflight(db.pool, MIGRATIONS_DIR);
    assert.equal(r.problems.some((p) => p.includes("014") || p.startsWith("migration")), false, r.problems.join(", "));
  });

  it("no code: no secret and no enrolment; a wrong code does not open it", async () => {
    const u = await makeUser(db.pool, "manager", "gate.none@example.test");
    const { token, pending } = await pendingFor(db.pool, u.email);
    assert.equal(await offerEnrollment(db.pool, pending, KEY), null);
    const e = await beginEnrollment(db.pool, u.id, KEY);
    const refused = await completeMfaLogin(db.pool, { pendingToken: token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: OWNER_IP });
    assert.equal(refused.ok, false);
    const wrong = await redeemEnrollmentCode(db.pool, { pendingToken: token, code: "ABCD-EFGH-JKLM", ip: OWNER_IP });
    assert.deepEqual(wrong, { ok: false, reason: "invalid" });
    assert.equal(await mayEnroll(db.pool, pending), false);
  });

  it("the Owner's valid code opens enrolment for THIS session; then the secret is offered and enrolment completes", async () => {
    const u = await makeUser(db.pool, "manager", "gate.valid@example.test");
    const { token, pending } = await pendingFor(db.pool, u.email);
    const { code } = await issueEnrollmentCode(db.pool, { id: owner.id, role: "owner" }, u.id);
    assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: token, code, ip: OWNER_IP }), { ok: true });

    const afterCode = (await validateSession(db.pool, token, { state: "pending", withEnroll: true }))!;
    assert.equal(await mayEnroll(db.pool, afterCode), true);
    const offered = await offerEnrollment(db.pool, afterCode, KEY);
    assert.ok(offered, "the secret is offered once the code is redeemed");
    const done = await completeMfaLogin(db.pool, { pendingToken: token, code: totpAt(offered.secret, Date.now()), mfaKey: KEY, ip: OWNER_IP });
    assert.equal(done.ok, true);
    assert.equal(done.ok && done.recoveryCodes?.length, 10);
    assert.equal(pending.user.id, u.id);
  });

  it("a code is one-time and belongs to the person: another employee's session cannot use it", async () => {
    const a = await makeUser(db.pool, "editor", "gate.a@example.test");
    const b = await makeUser(db.pool, "editor", "gate.b@example.test");
    const pa = await pendingFor(db.pool, a.email);
    const pb = await pendingFor(db.pool, b.email);
    const { code } = await issueEnrollmentCode(db.pool, { id: owner.id, role: "owner" }, a.id);
    assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: pb.token, code, ip: OWNER_IP }), { ok: false, reason: "invalid" });
    assert.equal(await mayEnroll(db.pool, pb.pending), false);
    assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: pa.token, code, ip: OWNER_IP }), { ok: true });
    assert.deepEqual(await redeemEnrollmentCode(db.pool, { pendingToken: pa.token, code, ip: OWNER_IP }), { ok: false, reason: "invalid" }, "one-time");
  });
});

describe("P1-2: resetting another person's second factor needs the Owner's fresh step-up", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let n = 0;
  const A = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });
  const ownerActor = () => A({ id: owner.id, role: "owner" });
  const count = async (sql: string, p: unknown[] = []) => Number((await db.pool.query(sql, p)).rows[0].v);

  /** A person with an enrolled authenticator and one active session (the thing a reset must end). */
  async function enrolledPerson(role: "manager" | "editor" = "manager") {
    const u = await makeUser(db.pool, role, `reset${++n}.${role}@example.test`);
    const e = await beginEnrollment(db.pool, u.id, KEY);
    await confirmEnrollment(db.pool, u.id, totpAt(e.secret, Date.now()), KEY);
    const { token } = await createSession(db.pool, u.id, { ip: OWNER_IP }, "verified", { mfaVerified: true });
    return { user: u, token };
  }
  /** A signed-in Owner session WITHOUT any step-up: what a stolen or hijacked session looks like. */
  async function plainOwnerSession() {
    const { token } = await createSession(db.pool, owner.id, { ip: OWNER_IP }, "verified", { mfaVerified: true });
    return { sessionId: (await validateSession(db.pool, token))!.sessionId };
  }

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner", "reset.owner@example.test");
  });
  after(async () => db.stop());

  it("the Owner without a fresh step-up cannot reset anyone (the stolen-session case)", async () => {
    const target = await enrolledPerson();
    const plain = await plainOwnerSession();
    await assert.rejects(
      () => resetUserMfa(db.pool, ownerActor(), target.user.id, { ...plain, ip: OWNER_IP }),
      (e: unknown) => e instanceof ForbiddenError && e.message === "step_up_required",
    );
    assert.equal(await isEnrolled(db.pool, target.user.id), true, "the factor is still there");
    assert.ok(await validateSession(db.pool, target.token), "the target's session still lives");
  });

  it("a step-up for ANOTHER purpose does not reset the factor", async () => {
    const target = await enrolledPerson();
    const wrong = await stepUpProof(db.pool, owner, "enrollment_code");
    await assert.rejects(() => resetUserMfa(db.pool, ownerActor(), target.user.id, { ...wrong, ip: OWNER_IP }), ForbiddenError);
    assert.equal(await isEnrolled(db.pool, target.user.id), true);
  });

  it("the Owner with a fresh mfa_reset step-up resets; the grant is spent and the reset is audited", async () => {
    const target = await enrolledPerson();
    const proof = await stepUpProof(db.pool, owner);
    assert.equal(await hasStepUp(db.pool, owner.id, proof.sessionId, "mfa_reset"), true);
    await resetUserMfa(db.pool, ownerActor(), target.user.id, { ...proof, ip: OWNER_IP });
    assert.equal(await isEnrolled(db.pool, target.user.id), false);
    assert.equal(await validateSession(db.pool, target.token), null, "their sessions ended");
    assert.equal(await hasStepUp(db.pool, owner.id, proof.sessionId, "mfa_reset"), false, "the grant is spent");
    assert.equal(await count("SELECT count(*)::int AS v FROM bb.audit_log WHERE action = 'mfa.reset' AND entity_id = $1 AND actor_user_id = $2", [target.user.id, owner.id]), 1);
  });

  it("a grant cannot be used twice", async () => {
    const first = await enrolledPerson();
    const second = await enrolledPerson();
    const proof = await stepUpProof(db.pool, owner);
    await resetUserMfa(db.pool, ownerActor(), first.user.id, proof);
    await assert.rejects(() => resetUserMfa(db.pool, ownerActor(), second.user.id, proof), (e: unknown) => e instanceof ForbiddenError && e.message === "step_up_required");
    assert.equal(await isEnrolled(db.pool, second.user.id), true, "the second person is untouched");
  });

  it("two parallel resets cannot both spend one grant", async () => {
    const a = await enrolledPerson();
    const b = await enrolledPerson();
    const proof = await stepUpProof(db.pool, owner);
    const results = await Promise.allSettled([resetUserMfa(db.pool, ownerActor(), a.user.id, proof), resetUserMfa(db.pool, ownerActor(), b.user.id, proof)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(ok, 1, "exactly one reset");
    assert.equal(refused.length, 1);
    assert.ok(refused[0].reason instanceof ForbiddenError, "the other one is refused");
    const stillEnrolled = [await isEnrolled(db.pool, a.user.id), await isEnrolled(db.pool, b.user.id)].filter(Boolean).length;
    assert.equal(stillEnrolled, 1, "one person was reset, one was not");
  });

  it("managers and editors are refused even with a grant in their own session", async () => {
    const target = await enrolledPerson();
    for (const role of ["manager", "editor"] as const) {
      const staff = await makeUser(db.pool, role, `reset.${role}.actor@example.test`);
      const { token } = await createSession(db.pool, staff.id, { ip: OWNER_IP }, "verified", { mfaVerified: true });
      const session = (await validateSession(db.pool, token))!;
      await grantStepUp(db.pool, { userId: staff.id, sessionId: session.sessionId, purpose: "mfa_reset", method: "totp" });
      await assert.rejects(() => resetUserMfa(db.pool, A({ id: staff.id, role }), target.user.id, { sessionId: session.sessionId }), ForbiddenError);
      assert.equal(await hasStepUp(db.pool, staff.id, session.sessionId, "mfa_reset"), true, "their grant was not spent by the refused attempt");
    }
    assert.equal(await isEnrolled(db.pool, target.user.id), true);
  });

  it("a failed transaction leaves nothing half-reset: factor, passkeys, sessions and the grant all stay", async () => {
    const target = await enrolledPerson();
    await db.pool.query(
      `INSERT INTO bb.passkeys (user_id, credential_id, public_key, device_type, label) VALUES ($1, $2, $3, 'singleDevice', 'test device')`,
      [target.user.id, `cred-${target.user.id}`, Buffer.alloc(32, 1)],
    );
    const proof = await stepUpProof(db.pool, owner);
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION bb.test_fail_mfa_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'mfa.reset' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
       CREATE TRIGGER test_fail_mfa_reset BEFORE INSERT ON bb.audit_log FOR EACH ROW EXECUTE FUNCTION bb.test_fail_mfa_reset();`,
    );
    try {
      await assert.rejects(() => resetUserMfa(db.pool, ownerActor(), target.user.id, { ...proof, ip: OWNER_IP }), /injected failure/);
    } finally {
      await db.pool.query("DROP TRIGGER IF EXISTS test_fail_mfa_reset ON bb.audit_log; DROP FUNCTION IF EXISTS bb.test_fail_mfa_reset();");
    }
    assert.equal(await isEnrolled(db.pool, target.user.id), true, "the TOTP factor is intact");
    assert.equal(await count("SELECT count(*)::int AS v FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [target.user.id]), 1, "the passkey is intact");
    assert.ok(await validateSession(db.pool, target.token), "the session is intact");
    assert.equal(await hasStepUp(db.pool, owner.id, proof.sessionId, "mfa_reset"), true, "the grant was rolled back, so it can still be used");
  });

  it("the emergency console path is unchanged: it needs no Owner session (audited as the server console)", async () => {
    const target = await enrolledPerson();
    assert.equal(await resetUserMfaByEmail(db.pool, target.user.email), true);
    assert.equal(await isEnrolled(db.pool, target.user.id), false);
    assert.equal(await count("SELECT count(*)::int AS v FROM bb.audit_log WHERE action = 'mfa.reset' AND entity_id = $1 AND actor_user_id IS NULL", [target.user.id]), 1);
  });
});
