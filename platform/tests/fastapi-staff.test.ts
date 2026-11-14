import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fastApiActorForStaff } from "../src/server/fastapi-staff.ts";

const TOKEN = "s".repeat(40);
const ASSERTION_SECRET = "a".repeat(40);
const saved = {
  token: process.env.CRM_SERVICE_TOKEN,
  assertion: process.env.CRM_STAFF_ASSERTION_SECRET,
  base: process.env.FASTAPI_ADMIN_BASE_URL,
};

function stub(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("staff token bridge (server only)", () => {
  beforeEach(() => {
    process.env.CRM_SERVICE_TOKEN = TOKEN;
    process.env.CRM_STAFF_ASSERTION_SECRET = ASSERTION_SECRET;
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
  });
  afterEach(() => {
    if (saved.token === undefined) delete process.env.CRM_SERVICE_TOKEN;
    else process.env.CRM_SERVICE_TOKEN = saved.token;
    if (saved.assertion === undefined) delete process.env.CRM_STAFF_ASSERTION_SECRET;
    else process.env.CRM_STAFF_ASSERTION_SECRET = saved.assertion;
    if (saved.base === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = saved.base;
  });

  it("asks FastAPI for a token for the given staff email with the service secret in a header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const actor = await fastApiActorForStaff(
      { id: "platform-staff-1", email: " STAFF-3@EXAMPLE.NET ", role: "manager" },
      { requestId: "req-1", fetchImpl: stub(200, { access_token: "bridge-token", token_type: "bearer", expires_in_seconds: 900, user: {} }, calls) },
    );
    assert.equal(actor.accessToken, "bridge-token");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/auth/service/staff-access-token");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("x-crm-service-token"), TOKEN);
    assert.equal(headers.get("authorization"), null, "no bearer on the bridge call");
    const assertion = headers.get("x-crm-staff-assertion");
    assert.ok(assertion);
    const [version, encoded, signature] = assertion.split(".");
    assert.equal(version, "v1");
    assert.equal(signature, createHmac("sha256", ASSERTION_SECRET).update(encoded, "ascii").digest("hex"));
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    assert.equal(payload.staffId, "platform-staff-1");
    assert.equal(payload.email, "staff-3@example.net");
    assert.equal(payload.platformRole, "manager");
    assert.equal(payload.requestId, "req-1");
    assert.equal(payload.expiresAt - payload.issuedAt, 60);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: "staff-3@example.net", requestId: "req-1" });
  });

  it("returns only the access token, never a refresh token or the service secret", async () => {
    const actor = await fastApiActorForStaff(
      { id: "platform-staff-2", email: "staff-3@example.net", role: "manager" },
      { requestId: "req-2", fetchImpl: stub(200, { access_token: "bridge-token", refresh_token: "must-not-leak" }, []) },
    );
    assert.deepEqual(Object.keys(actor).sort(), ["accessToken", "requestId"]);
    assert.ok(!JSON.stringify(actor).includes("must-not-leak"));
    assert.ok(!JSON.stringify(actor).includes(TOKEN));
  });

  it("fails closed when the service secret is missing or short", async () => {
    process.env.CRM_SERVICE_TOKEN = "short";
    await assert.rejects(
      fastApiActorForStaff({ id: "staff-1", email: "staff-1@example.net", role: "manager" }, { requestId: "r", fetchImpl: stub(200, { access_token: "x" }, []) }),
      (error: Error) => error.message === "crm_actor_missing",
    );
  });

  it("fails closed when the staff assertion secret is missing", async () => {
    delete process.env.CRM_STAFF_ASSERTION_SECRET;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await assert.rejects(
      fastApiActorForStaff({ id: "platform-staff-3", email: "staff-1@example.net", role: "manager" }, { requestId: "r", fetchImpl: stub(200, { access_token: "x" }, calls) }),
      (error: Error) => error.message === "crm_actor_missing",
    );
    assert.equal(calls.length, 0);
  });

  it("fails closed when FastAPI refuses the staff member (unlinked, inactive, or bad secret)", async () => {
    await assert.rejects(
      fastApiActorForStaff({ id: "staff-2", email: "staff-2@example.net", role: "manager" }, { requestId: "r", fetchImpl: stub(403, { error: { code: "staff_not_linked" } }, []) }),
      (error: Error & { code?: string; status?: number }) => error.code === "staff_not_linked" && error.status === 403,
    );
  });

  it("fails closed on a response without a token", async () => {
    await assert.rejects(
      fastApiActorForStaff({ id: "staff-3", email: "staff-1@example.net", role: "manager" }, { requestId: "r", fetchImpl: stub(200, { ok: true }, []) }),
      (error: Error & { code?: string }) => error.code === "staff_token_missing",
    );
  });
});
