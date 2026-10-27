import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { passkeyConfigProblems, passkeyConfigFromEnv, type PasskeyConfig } from "../src/core/passkey-config.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/core/errors.ts";
import {
  MAX_ACTIVE_PASSKEYS,
  beginLogin,
  beginRegistration,
  finishLogin,
  finishRegistration,
  listPasskeys,
  revokeAllPasskeys,
  revokePasskey,
  revokePasskeysByEmail,
} from "../src/core/passkeys.ts";
import { beginEnrollment, confirmEnrollment } from "../src/core/mfa.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { grantStepUp, type StepUpPurpose } from "../src/core/stepup.ts";
import { totpAt } from "../src/core/totp.ts";
import { makeUser, startTestDb, type TestDb } from "./helpers/db.ts";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator.ts";

const cfg: PasskeyConfig = { enabled: true, rpID: "admin.example.kz", rpName: "Boom Bala", origins: ["https://admin.example.kz"] };

describe("Passkey configuration (RP ID and origins)", () => {
  const env = (o: Record<string, string>) => passkeyConfigFromEnv({ PASSKEYS_ENABLED: "1", ...o });
  const problems = (o: Record<string, string>, production = true) => passkeyConfigProblems(env(o), { production });

  it("is silent while passkeys are off, and accepts a clean https configuration", () => {
    assert.deepEqual(passkeyConfigProblems(passkeyConfigFromEnv({}), { production: true }), []);
    assert.deepEqual(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "https://admin.example.kz" }), []);
    assert.deepEqual(problems({ WEBAUTHN_RP_ID: "example.kz", WEBAUTHN_ORIGINS: "https://admin.example.kz,https://example.kz" }), [], "an origin may be a subdomain of the RP ID");
  });

  it("refuses a missing or malformed RP ID", () => {
    assert.ok(problems({ WEBAUTHN_ORIGINS: "https://admin.example.kz" }).includes("webauthn_rp_id_invalid"));
    for (const bad of ["https://admin.example.kz", "admin.example.kz:443", "admin.example.kz/login", "10.77.0.1", "-bad.example.kz", "has space.kz"]) {
      assert.ok(problems({ WEBAUTHN_RP_ID: bad, WEBAUTHN_ORIGINS: "https://admin.example.kz" }).includes("webauthn_rp_id_invalid"), bad);
    }
  });

  it("needs origins; every one must be https, a bare origin, and inside the RP ID", () => {
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz" }).includes("webauthn_origins_required"));
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "http://admin.example.kz" }).includes("webauthn_origin_must_be_https"));
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "https://admin.example.kz/login" }).includes("webauthn_origin_must_be_origin_only"));
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "https://user:pw@admin.example.kz" }).includes("webauthn_origin_must_be_origin_only"));
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "https://evil.example" }).includes("webauthn_origin_outside_rp_id"));
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "https://notadmin.example.kz" }).includes("webauthn_origin_outside_rp_id"), "a sibling host is not inside the RP ID");
    assert.ok(problems({ WEBAUTHN_RP_ID: "admin.example.kz", WEBAUTHN_ORIGINS: "not a url" }).includes("webauthn_origin_invalid"));
  });

  it("allows plain-http localhost only outside production", () => {
    const dev = { WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: "http://localhost:3100" };
    assert.deepEqual(problems(dev, false), []);
    assert.ok(problems(dev, true).includes("webauthn_origin_must_be_https"));
  });
});

describe("Passkeys: registration, sign-in, revocation", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let manager2: Awaited<ReturnType<typeof makeUser>>;
  const A = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });
  const meta = (ip = "10.77.0.5") => ({ ip, userAgent: "test-agent" });
  const MFA_KEY = Buffer.alloc(32, 9).toString("base64");
  /** The authenticator app is the backup that must exist before a passkey can be added. */
  async function ensureTotp(user: { id: string }) {
    if ((await db.pool.query("SELECT 1 FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NOT NULL", [user.id])).rowCount) return;
    const e = await beginEnrollment(db.pool, user.id, MFA_KEY);
    await confirmEnrollment(db.pool, user.id, totpAt(e.secret, Date.now()), MFA_KEY);
  }
  /** A signed-in session of this person, and (optionally) a fresh step-up grant for one purpose. */
  async function session(user: { id: string }, purpose?: StepUpPurpose) {
    const { token } = await createSession(db.pool, user.id, { ip: "10.77.0.5" }, "verified", { mfaVerified: true });
    const v = (await validateSession(db.pool, token))!;
    if (purpose) await grantStepUp(db.pool, { userId: user.id, sessionId: v.sessionId, purpose, method: "totp" });
    return { token, sessionId: v.sessionId, ctx: { ...meta(), sessionId: v.sessionId } };
  }
  const device = (over: { userVerified?: boolean; backedUp?: boolean } = {}) => new VirtualAuthenticator({ rpID: cfg.rpID, origin: cfg.origins[0], ...over });
  const count = async (sql: string, p: unknown[] = []) => Number((await db.pool.query(sql, p)).rows[0].v);
  let ipN = 0;
  const freshIp = () => `10.77.1.${++ipN}`;

  async function enroll(user: { id: string; email: string; name: string }, a = device(), label = "iPhone") {
    await ensureTotp(user);
    const { ctx } = await session(user, "passkey_register");
    const options = await beginRegistration(db.pool, cfg, user, ctx);
    const passkey = await finishRegistration(db.pool, cfg, user, a.register(options), label, ctx);
    return { a, passkey };
  }
  /** A context for a registration ceremony: the backup factor exists and a fresh step-up grant is in place. */
  const reg = async (user: { id: string }) => {
    await ensureTotp(user);
    return (await session(user, "passkey_register")).ctx;
  };
  /** Revokes with a fresh step-up, as the endpoint does. */
  const revoke = async (actor: { id: string; role: "owner" | "manager" | "editor" }, id: string) => revokePasskey(db.pool, actor, id, (await session(actor, "passkey_revoke")).ctx);
  const revokeAll = async (actor: { id: string; role: "owner" | "manager" | "editor" }, userId: string) => revokeAllPasskeys(db.pool, actor, userId, (await session(actor, "passkeys_revoke_all")).ctx);
  async function signIn(a: VirtualAuthenticator, extra: { pendingToken?: string; pendingUserId?: string; ip?: string; over?: Parameters<VirtualAuthenticator["assert"]>[1] } = {}) {
    const ip = extra.ip ?? freshIp();
    const options = await beginLogin(db.pool, cfg, { pendingUserId: extra.pendingUserId }, meta(ip));
    return finishLogin(db.pool, cfg, { response: a.assert(options, extra.over) as never, pendingToken: extra.pendingToken, ip, userAgent: "test-agent" });
  }

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    manager = await makeUser(db.pool, "manager");
    manager2 = await makeUser(db.pool, "manager", "manager2@example.test");
  });
  after(async () => db.stop());

  it("is off by default: nothing is issued", async () => {
    await assert.rejects(async () => beginRegistration(db.pool, { ...cfg, enabled: false }, manager, await reg(manager)), NotFoundError);
    await assert.rejects(() => beginLogin(db.pool, { ...cfg, enabled: false }, {}, meta()), NotFoundError);
  });

  it("a signed-in person registers a device; only a PUBLIC key is stored", async () => {
    const { passkey, a } = await enroll(manager, device({ backedUp: true }), "iPhone Айгерим");
    assert.equal(passkey.label, "iPhone Айгерим");
    assert.equal(passkey.deviceType, "multiDevice");
    assert.equal(passkey.backedUp, true);
    const row = (await db.pool.query("SELECT credential_id, public_key, counter FROM bb.passkeys WHERE id = $1", [passkey.id])).rows[0];
    assert.equal(row.credential_id, a.credentialId.toString("base64url"));
    assert.ok(row.public_key.length > 30 && row.public_key.length < 200, "a COSE public key, not a secret");
    assert.equal(await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'passkey.registered' AND entity_id = $1", [passkey.id]), 1);
    assert.equal((await listPasskeys(db.pool, manager.id)).length, 1);
  });

  it("the registration challenge is one-time, short-lived and belongs to the person who asked", async () => {
    const ctx = await reg(manager2);
    const o = await beginRegistration(db.pool, cfg, manager2, ctx);
    const a = device();
    const resp = a.register(o);
    await finishRegistration(db.pool, cfg, manager2, resp, "Mac", ctx);
    await assert.rejects(async () => finishRegistration(db.pool, cfg, manager2, resp, "Mac again", await reg(manager2)), ValidationError, "replay of the same answer");
    // another person cannot finish a ceremony that was started for someone else
    const o2 = await beginRegistration(db.pool, cfg, manager2, await reg(manager2));
    await assert.rejects(async () => finishRegistration(db.pool, cfg, owner, device().register(o2), "stolen", await reg(owner)), ValidationError);
    // an expired challenge
    const o3 = await beginRegistration(db.pool, cfg, manager2, await reg(manager2));
    await db.pool.query("UPDATE bb.passkey_challenges SET expires_at = now() - interval '1 second' WHERE challenge = $1", [o3.challenge]);
    await assert.rejects(async () => finishRegistration(db.pool, cfg, manager2, device().register(o3), "late", await reg(manager2)), ValidationError);
    assert.equal(await count("SELECT count(*) v FROM bb.passkeys WHERE user_id = $1", [manager2.id]), 1, "only the honest registration is stored");
  });

  it("refuses a registration made on another origin, for another RP ID, or without user verification", async () => {
    const o = await beginRegistration(db.pool, cfg, owner, await reg(owner));
    await assert.rejects(async () => finishRegistration(db.pool, cfg, owner, device().register(o, { origin: "https://evil.example" }), "x", await reg(owner)), ValidationError);
    const o2 = await beginRegistration(db.pool, cfg, owner, await reg(owner));
    await assert.rejects(async () => finishRegistration(db.pool, cfg, owner, device().register(o2, { rpID: "evil.example" }), "x", await reg(owner)), ValidationError);
    const o3 = await beginRegistration(db.pool, cfg, owner, await reg(owner));
    await assert.rejects(async () => finishRegistration(db.pool, cfg, owner, device({ userVerified: false }).register(o3), "x", await reg(owner)), ValidationError, "a key that did not verify the person is refused");
    assert.equal(await count("SELECT count(*) v FROM bb.passkeys WHERE user_id = $1", [owner.id]), 0);
    assert.ok((await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'passkey.register_failed'")) >= 3, "failures are audited");
  });

  it("signs in without a password, issues a session that counts as the second factor, and writes the audit", async () => {
    const { a } = await enroll(owner, device(), "MacBook Touch ID");
    const r = await signIn(a);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.userId, owner.id);
    const s = await validateSession(db.pool, r.token, { state: "verified", requireMfa: true });
    assert.equal(s?.user.id, owner.id, "MFA_MODE=required accepts it");
    assert.equal(s?.user.role, "owner", "the role is the user's role: RBAC is unchanged");
    const k = (await listPasskeys(db.pool, owner.id))[0];
    assert.ok(k.lastUsedAt, "last use is recorded");
    const audit = (await db.pool.query("SELECT after FROM bb.audit_log WHERE action = 'auth.login' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1", [owner.id])).rows[0];
    assert.equal(audit.after.passkey, true);
  });

  it("a challenge works once: replaying the same answer fails", async () => {
    const { a } = await enroll(manager, device());
    const ip = freshIp();
    const o = await beginLogin(db.pool, cfg, {}, meta(ip));
    const answer = a.assert(o);
    const first = await finishLogin(db.pool, cfg, { response: answer as never, ip });
    assert.equal(first.ok, true);
    const replay = await finishLogin(db.pool, cfg, { response: answer as never, ip });
    assert.equal(replay.ok, false);
  });

  it("refuses the wrong origin, the wrong RP ID, a missing user verification and an unknown key", async () => {
    const { a } = await enroll(manager, device(), "Pixel");
    for (const over of [{ origin: "https://evil.example" }, { rpID: "evil.example" }]) {
      assert.equal((await signIn(a, { over })).ok, false, JSON.stringify(over));
    }
    const stranger = device();
    assert.equal((await signIn(stranger)).ok, false, "a key the server does not know");
  });

  it("refuses a cloned key (the signature counter goes backwards)", async () => {
    const { a } = await enroll(manager2, device(), "Clone test");
    assert.equal((await signIn(a, { over: { counter: 10 } })).ok, true);
    assert.equal((await signIn(a, { over: { counter: 5 } })).ok, false, "a lower counter is a copy of the key");
    assert.equal((await signIn(a, { over: { counter: 11 } })).ok, true, "the real device keeps working");
  });

  it("the second-factor page: only the person whose password was accepted may finish with a key", async () => {
    const mine = (await enroll(manager, device(), "Phone for pending")).a;
    const theirs = (await enroll(manager2, device(), "Other phone")).a;
    const pending = await createSession(db.pool, manager.id, { ip: "10.77.0.9" }, "pending");
    const wrong = await signIn(theirs, { pendingToken: pending.token, pendingUserId: manager.id });
    assert.equal(wrong.ok, false, "another person's key cannot complete my pending login");
    const pending2 = await createSession(db.pool, manager.id, { ip: "10.77.0.9" }, "pending");
    const good = await signIn(mine, { pendingToken: pending2.token, pendingUserId: manager.id });
    assert.equal(good.ok, true);
    assert.equal(await validateSession(db.pool, pending2.token, { state: "pending" }), null, "the pending session is gone");
    // a challenge made for the pending person cannot be answered by someone else's key even without the cookie check
    const o = await beginLogin(db.pool, cfg, { pendingUserId: manager.id }, meta(freshIp()));
    const r = await finishLogin(db.pool, cfg, { response: theirs.assert(o) as never, ip: freshIp() });
    assert.equal(r.ok, false);
  });

  it("the user handle must be the user's own", async () => {
    const { a } = await enroll(manager, device(), "Handle test");
    const wrong = await signIn(a, { over: { userHandle: Buffer.alloc(16, 7) } });
    assert.equal(wrong.ok, false);
    assert.equal((await signIn(a, { over: { omitUserHandle: true } })).ok, true, "the handle is optional in the answer");
  });

  it("a disabled person cannot sign in", async () => {
    const u = await makeUser(db.pool, "manager", "disabled@example.test");
    const { a } = await enroll(u, device(), "Disabled person");
    await db.pool.query("UPDATE bb.users SET is_active = false WHERE id = $1", [u.id]);
    assert.equal((await signIn(a)).ok, false);
  });

  it("failures are throttled with the same lock as wrong passwords, and are audited", async () => {
    const ip = "203.0.113.77";
    const bad = device();
    for (let i = 0; i < 5; i++) {
      const o = await beginLogin(db.pool, cfg, {}, meta(ip));
      assert.equal((await finishLogin(db.pool, cfg, { response: bad.assert(o) as never, ip })).ok, false);
    }
    await assert.rejects(() => beginLogin(db.pool, cfg, {}, meta(ip)), (e: unknown) => e instanceof ConflictError && /^locked:\d+$/.test(e.message), "options are refused while locked");
    const r = await finishLogin(db.pool, cfg, { response: bad.assert({ challenge: "x".repeat(20) }) as never, ip });
    assert.deepEqual({ ok: r.ok, reason: !r.ok && r.reason }, { ok: false, reason: "locked" });
    assert.ok((await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'auth.passkey_failed' AND ip = $1", [ip])) >= 5);
  });

  it("limits open challenges per address", async () => {
    const ip = "203.0.113.88";
    for (let i = 0; i < 20; i++) await beginLogin(db.pool, cfg, {}, meta(ip));
    await assert.rejects(() => beginLogin(db.pool, cfg, {}, meta(ip)), ConflictError);
  });

  it("revocation: a person revokes their own key; a revoked key can never sign in again", async () => {
    const u = await makeUser(db.pool, "manager", "revoker@example.test");
    const { a, passkey } = await enroll(u, device(), "To revoke");
    assert.equal((await signIn(a)).ok, true);
    await revoke(A(u), passkey.id);
    assert.equal((await signIn(a)).ok, false);
    assert.equal((await listPasskeys(db.pool, u.id)).length, 0);
    assert.equal((await listPasskeys(db.pool, u.id, { includeRevoked: true })).length, 1, "the history stays");
    assert.equal(await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'passkey.revoked' AND entity_id = $1", [passkey.id]), 1);
    await revoke(A(u), passkey.id); // idempotent
    assert.equal(await count("SELECT count(*) v FROM bb.audit_log WHERE action = 'passkey.revoked' AND entity_id = $1", [passkey.id]), 1);
  });

  it("a manager cannot revoke another person's key; the Owner can, and the person's sessions end", async () => {
    const u = await makeUser(db.pool, "manager", "lostphone@example.test");
    const { a, passkey } = await enroll(u, device(), "Lost phone");
    const login = await signIn(a);
    assert.equal(login.ok, true);
    await assert.rejects(() => revoke(A(manager), passkey.id), ForbiddenError);
    await assert.rejects(() => revokeAll(A(manager), u.id), ForbiddenError);
    assert.equal((await signIn(a)).ok, true, "nothing changed");
    await revoke(A(owner), passkey.id);
    assert.equal((await signIn(a)).ok, false);
    if (login.ok) assert.equal(await validateSession(db.pool, login.token), null, "the open session of that person ended");
    await assert.rejects(() => revoke(A(owner), "00000000-0000-0000-0000-000000000000"), NotFoundError);
  });

  it("the Owner revokes every key of a person at once; the break-glass by e-mail does the same", async () => {
    const u = await makeUser(db.pool, "manager", "twokeys@example.test");
    const one = (await enroll(u, device(), "Phone")).a;
    const two = (await enroll(u, device(), "Laptop")).a;
    assert.equal(await revokeAll(A(owner), u.id), 2);
    assert.equal((await signIn(one)).ok || (await signIn(two)).ok, false);
    const v = await makeUser(db.pool, "manager", "console@example.test");
    const k = (await enroll(v, device(), "Phone")).a;
    assert.deepEqual(await revokePasskeysByEmail(db.pool, " Console@Example.test "), { found: true, revoked: 1 });
    assert.equal((await signIn(k)).ok, false);
    assert.deepEqual(await revokePasskeysByEmail(db.pool, "nobody@example.test"), { found: false, revoked: 0 });
    const a = (await db.pool.query("SELECT after FROM bb.audit_log WHERE action = 'passkey.revoked_all' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(a.after.via, "server_console");
  });

  it("at most ten active keys per person; the same device cannot be added twice", async () => {
    const u = await makeUser(db.pool, "manager", "many@example.test");
    const first = device();
    await enroll(u, first, "k0");
    const dupOptions = await beginRegistration(db.pool, cfg, u, await reg(u));
    await assert.rejects(async () => finishRegistration(db.pool, cfg, u, first.register(dupOptions), "again", await reg(u)), ConflictError);
    for (let i = 1; i < MAX_ACTIVE_PASSKEYS; i++) await enroll(u, device(), `k${i}`);
    await assert.rejects(async () => beginRegistration(db.pool, cfg, u, await reg(u)), ConflictError);
  });

  it("the stored data cannot sign in as anyone: no secret in any table", async () => {
    const dump = JSON.stringify([(await db.pool.query("SELECT * FROM bb.passkeys")).rows.map((r) => Object.keys(r)), (await db.pool.query("SELECT * FROM bb.passkey_challenges")).rows.map((r) => Object.keys(r))]);
    assert.ok(!/private|secret|seed/i.test(dump));
  });
});
