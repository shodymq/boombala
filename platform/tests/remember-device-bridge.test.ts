import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";
import { beginEnrollment } from "../src/core/mfa.ts";
import { hashToken } from "../src/core/session.ts";
import { totpAt } from "../src/core/totp.ts";
import { makeUser, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

register("./helpers/next-stub-hooks.mjs", import.meta.url);

const MFA_KEY = Buffer.alloc(32, 41).toString("base64");

describe("remembered sessions through the authenticated bridge", () => {
  let db: TestDb;
  let serviceToken: string;
  let user: Awaited<ReturnType<typeof makeUser>>;
  let api: typeof import("../src/server/legacy-bridge.ts");
  let serverPool: ReturnType<typeof import("../src/server/db.ts").getPool>;
  const oldEnv = new Map<string, string | undefined>();

  before(async () => {
    db = await startTestDb();
    user = await makeUser(db.pool, "manager", "remember-bridge@example.test");
    serviceToken = randomBytes(32).toString("hex");
    for (const key of ["DATABASE_URL", "CRM_SERVICE_TOKEN", "MFA_ENC_KEY", "MFA_MODE"]) oldEnv.set(key, process.env[key]);
    process.env.DATABASE_URL = db.url;
    process.env.CRM_SERVICE_TOKEN = serviceToken;
    process.env.MFA_ENC_KEY = MFA_KEY;
    process.env.MFA_MODE = "required";
    api = await import("../src/server/legacy-bridge.ts");
    const dbModule = await import("../src/server/db.ts");
    serverPool = dbModule.getPool();
  });

  after(async () => {
    await serverPool?.end();
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db?.stop();
  });

  it("carries the server-recorded choice through password, MFA, cookie session validation and logout", async () => {
    const request = (path: string, body: unknown, bearer?: string) => new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-crm-service-token": serviceToken,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }) as import("next/server").NextRequest;

    const passwordResponse = await api.bridgeLogin(request("/api/bridge/auth/login", {
      email: user.email, password: TEST_PASSWORD, mfaRequired: true, rememberDevice: true,
    }));
    assert.equal(passwordResponse.status, 200);
    const pending = await passwordResponse.json() as { ok: boolean; token: string; mfa: string };
    assert.equal(pending.ok, true);
    assert.equal(pending.mfa, "enroll");
    const pendingSession = await import("../src/core/session.ts").then(({ validateSession }) => validateSession(db.pool, pending.token, { state: "pending" }));
    assert.equal(pendingSession?.rememberDevice, true);

    const enrollment = await beginEnrollment(db.pool, user.id, MFA_KEY);
    const mfaResponse = await api.bridgeMfa(request("/api/bridge/auth/mfa", {
      pendingToken: pending.token, code: totpAt(enrollment.secret, Date.now()),
    }));
    assert.equal(mfaResponse.status, 200);
    const verified = await mfaResponse.json() as { ok: boolean; token: string; expiresAt: string };
    assert.equal(verified.ok, true);
    const dbRow = (await db.pool.query("SELECT remember_device, mfa_verified_at IS NOT NULL AS mfa_ok FROM bb.sessions WHERE token_hash=$1", [hashToken(verified.token)])).rows[0];
    assert.equal(dbRow.remember_device, true);
    assert.equal(dbRow.mfa_ok, true);

    const sessionResponse = await api.bridgeSessionResponse(new Request("http://localhost/api/bridge/auth/session", {
      headers: { "x-crm-service-token": serviceToken, authorization: `Bearer ${verified.token}` },
    }) as import("next/server").NextRequest);
    const body = await sessionResponse.json() as { session: { rememberDevice: boolean; user: { role: string } } | null };
    assert.equal(body.session?.rememberDevice, true);
    assert.equal(body.session?.user.role, "manager");

    const dashboardResponse = await api.bridgeRpc(request("/api/bridge/rpc", { op: "dashboard", input: {} }, verified.token));
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json() as { workspace: { overdueActions: unknown[] | null; newRequests: unknown[] | null; callsToday: unknown[] | null; upcomingBirthdays: unknown[] | null } };
    assert.ok(Array.isArray(dashboard.workspace.overdueActions));
    assert.ok(Array.isArray(dashboard.workspace.newRequests));
    assert.ok(Array.isArray(dashboard.workspace.callsToday));
    assert.ok(Array.isArray(dashboard.workspace.upcomingBirthdays));

    const logoutResponse = await api.bridgeLogout(request("/api/bridge/auth/logout", {}, verified.token));
    assert.equal(logoutResponse.status, 200);
    assert.equal(await import("../src/core/session.ts").then(({ validateSession }) => validateSession(db.pool, verified.token)), null);
  });
});
