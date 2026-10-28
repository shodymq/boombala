import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { beginPasskeyLogin, beginPasskeyRegistration, finishPasskeyLogin, listPasskeys, PasskeyLockedError, revokePasskey } from "../src/core/passkeys.ts";
import { createSession } from "../src/core/session.ts";
import { ValidationError } from "../src/core/errors.ts";
import { makeUser, startTestDb, type TestDb } from "./helpers/db.ts";

const CONFIG = { rpID: "crm.example.test", origin: "https://crm.example.test", rpName: "Boom Bala CRM" };

describe("WebAuthn passkeys", () => {
  let db: TestDb;
  let userId: string;

  before(async () => {
    db = await startTestDb();
    userId = (await makeUser(db.pool, "owner", "passkey@example.test")).id;
  });
  after(async () => db.stop());

  it("creates a registration ceremony with a required user verification and stores only the challenge", async () => {
    const options = await beginPasskeyRegistration(db.pool, userId, CONFIG);
    assert.equal(options.rp.id, CONFIG.rpID);
    assert.equal(options.rp.name, CONFIG.rpName);
    assert.equal(options.authenticatorSelection?.userVerification, "required");
    assert.ok(options.challenge.length >= 20);
    const stored = await db.pool.query("SELECT challenge, consumed_at FROM passkey_challenges WHERE user_id = $1 AND purpose = 'registration'", [userId]);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].challenge, options.challenge);
    assert.equal(stored.rows[0].consumed_at, null);
  });

  it("uses registration until the user has a credential, then offers only active credentials for login", async () => {
    const first = await beginPasskeyLogin(db.pool, userId, CONFIG);
    assert.equal(first.mode, "register");
    await db.pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1, $2, $3, 0, $4, 'singleDevice', false, 'test device')`,
      [userId, "credential-".padEnd(24, "x"), Buffer.alloc(32, 7), ["internal"]],
    );
    const login = await beginPasskeyLogin(db.pool, userId, CONFIG);
    assert.equal(login.mode, "authenticate");
    assert.equal(login.options.userVerification, "required");
    assert.deepEqual(login.options.allowCredentials?.map((x) => x.id), ["credential-".padEnd(24, "x")]);
    const registration = await beginPasskeyRegistration(db.pool, userId, CONFIG);
    assert.deepEqual(registration.excludeCredentials?.map((x) => x.id), ["credential-".padEnd(24, "x")]);
  });

  it("lists metadata without public keys and revokes only the owner's credential with an audit entry", async () => {
    const listed = await listPasskeys(db.pool, userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].label, "test device");
    assert.equal("publicKey" in listed[0], false);
    await revokePasskey(db.pool, userId, listed[0].id, { ip: "10.77.0.5", userAgent: "test" });
    assert.equal((await listPasskeys(db.pool, userId)).length, 0);
    const audit = await db.pool.query("SELECT action, after FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.passkey_revoked'", [userId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(JSON.stringify(audit.rows[0].after).includes("test device"), false);
  });

  it("counts failed ceremonies in the existing login throttle", async () => {
    await db.pool.query("DELETE FROM login_attempts WHERE email_norm = $1", ["passkey@example.test"]);
    await db.pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1, $2, $3, 0, $4, 'singleDevice', false, 'rate-limit device')`,
      [userId, "rate-limit-credential".padEnd(24, "x"), Buffer.alloc(32, 8), ["internal"]],
    );
    const options = await beginPasskeyLogin(db.pool, userId, CONFIG);
    assert.equal(options.mode, "authenticate");
    const pending = await createSession(db.pool, userId, { ip: "10.77.0.8", userAgent: "test" }, "pending");
    const response = {
      id: "rate-limit-credential".padEnd(24, "x"),
      rawId: "rate-limit-credential".padEnd(24, "x"),
      response: { clientDataJSON: "eA", authenticatorData: "eA", signature: "eA", userHandle: null },
      type: "public-key",
      clientExtensionResults: {},
    } as unknown as AuthenticationResponseJSON;
    await assert.rejects(() => finishPasskeyLogin(db.pool, { userId, pendingToken: pending.token, response, config: CONFIG }, { ip: "10.77.0.8", userAgent: "test" }), ValidationError);
    assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM login_attempts WHERE email_norm = $1", ["passkey@example.test"])).rows[0].count, 1);
    await db.pool.query("INSERT INTO login_attempts (email_norm, ip, success) SELECT $1, $2, false FROM generate_series(1, 4)", ["passkey@example.test", "10.77.0.8"]);
    await assert.rejects(() => finishPasskeyLogin(db.pool, { userId, pendingToken: pending.token, response, config: CONFIG }, { ip: "10.77.0.8", userAgent: "test" }), PasskeyLockedError);
  });
});
