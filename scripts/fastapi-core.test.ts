/**
 * Contract and safety tests for src/lib/fastapi/core.ts. No network: fetch is replaced by a stub.
 *
 *   npm run test:fastapi
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFastapiClient,
  correlationId,
  enabledFeatures,
  FastapiError,
  parseFastapiConfig,
  postBirthdayLead,
  postContactLead,
  redact,
  requestOtp,
  verifyOtp,
  type FastapiLogLine,
} from "../src/lib/fastapi/core.ts";

const BASE = "https://api-staging.example.kz/api/v1";
const config = { baseUrl: BASE, timeoutMs: 1000, features: new Set(["leads", "otp"] as const) } as const;

type Call = { url: string; init: RequestInit };

/** Returns a fetch stub that records calls and answers with the given status and JSON body. */
function stubFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, logs: FastapiLogLine[] = []) {
  return createFastapiClient({
    config,
    fetchImpl,
    logger: (line) => logs.push(line),
    newId: () => "generated-request-id-001",
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
  });
}

async function rejects(promise: Promise<unknown>): Promise<FastapiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FastapiError, `expected FastapiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

const LEAD_OK = { requestId: "req-1", submittedAt: "2026-10-26T10:00:00Z", nextStep: "manager_call" };

// ── Configuration: off by default, unsafe URLs refused ─────────────────────────────────────────

test("no feature flag means no client at all", () => {
  assert.equal(parseFastapiConfig({}), null);
  assert.equal(parseFastapiConfig({ FASTAPI_BASE_URL: BASE }), null);
});

test("unknown feature names are ignored, not enabled", () => {
  assert.equal(enabledFeatures("payments,leds").size, 0);
  assert.deepEqual([...enabledFeatures(" leads , payments ")], ["leads"]);
});

test("enabled feature with plain http to a public host is refused", () => {
  assert.throws(
    () => parseFastapiConfig({ FASTAPI_FEATURES: "leads", FASTAPI_BASE_URL: "http://api.example.kz/api/v1" }),
    (e: unknown) => e instanceof FastapiError && e.kind === "not_configured",
  );
});

test("https and localhost are accepted; trailing slash removed; timeout clamped", () => {
  const c = parseFastapiConfig({ FASTAPI_FEATURES: "otp", FASTAPI_BASE_URL: `${BASE}/`, FASTAPI_TIMEOUT_MS: "999999" });
  assert.equal(c?.baseUrl, BASE);
  assert.equal(c?.timeoutMs, 10_000);
  const local = parseFastapiConfig({ FASTAPI_FEATURES: "otp", FASTAPI_BASE_URL: "http://localhost:8000/api/v1" });
  assert.equal(local?.baseUrl, "http://localhost:8000/api/v1");
});

// ── Feature gating: disabled means no network call ─────────────────────────────────────────────

test("a disabled capability never reaches the network", async () => {
  const { calls, fetchImpl } = stubFetch(201, LEAD_OK);
  const client = createFastapiClient({ config: { ...config, features: new Set(["leads"]) }, fetchImpl });
  const err = await rejects(requestOtp(client, { phone: "+77071234567" }));
  assert.equal(err.kind, "disabled");
  assert.equal(calls.length, 0);
});

test("no config at all: not_configured, no network call", async () => {
  const { calls, fetchImpl } = stubFetch(201, LEAD_OK);
  const client = createFastapiClient({ config: null, fetchImpl });
  const err = await rejects(postContactLead(client, { name: "Айжан", phone: "+77071234567" }));
  assert.equal(err.kind, "not_configured");
  assert.equal(calls.length, 0);
});

// ── Success path and contract ──────────────────────────────────────────────────────────────────

test("birthday lead: POST to the real route, correlation header, parsed response", async () => {
  const { calls, fetchImpl } = stubFetch(201, LEAD_OK);
  const logs: FastapiLogLine[] = [];
  const out = await postBirthdayLead(clientWith(fetchImpl, logs), { name: "Айжан", phone: "+77071234567", branchId: "branch-main" });
  assert.deepEqual(out, LEAD_OK);
  assert.equal(calls[0].url, `${BASE}/mobile/leads/birthday`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-request-id"], "generated-request-id-001");
  assert.equal(logs[0].outcome, "ok");
  assert.equal(logs[0].route, "/mobile/leads/birthday");
});

test("contact lead: POST to /mobile/leads/contact and parse LeadCreatedResponse", async () => {
  const { calls, fetchImpl } = stubFetch(201, { id: "lead-1", type: "contact", status: "new" });
  const out = await postContactLead(clientWith(fetchImpl), { name: "Айжан", phone: "+77071234567", message: "вопрос" });
  assert.equal(out.id, "lead-1");
  assert.equal(calls[0].url, `${BASE}/mobile/leads/contact`);
});

test("request OTP and verify OTP use the auth routes and keep verification_id", async () => {
  const req = stubFetch(200, { verification_id: "v-1", expires_in_seconds: 300, resend_after_seconds: 60 });
  const otp = await requestOtp(clientWith(req.fetchImpl), { phone: "+77071234567" });
  assert.equal(otp.verification_id, "v-1");
  assert.equal(req.calls[0].url, `${BASE}/mobile/auth/request-otp`);

  const ver = stubFetch(200, {
    access_token: "a".repeat(20),
    refresh_token: "r".repeat(20),
    token_type: "bearer",
    expires_in_seconds: 900,
    refresh_expires_in_seconds: 2_592_000,
    user: { id: "u-1", phone: "+77071234567", email: null },
  });
  const auth = await verifyOtp(clientWith(ver.fetchImpl), { phone: "+77071234567", code: "123456", verification_id: "v-1" });
  assert.equal(auth.user.id, "u-1");
  assert.equal(ver.calls[0].url, `${BASE}/mobile/auth/verify-otp`);
});

test("a 2xx answer that breaks the contract is invalid_response", async () => {
  const { fetchImpl } = stubFetch(201, { requestId: "req-1" }); // missing submittedAt and nextStep
  const err = await rejects(postBirthdayLead(clientWith(fetchImpl), { name: "Айжан", phone: "+77071234567", branchId: "b" }));
  assert.equal(err.kind, "invalid_response");
});

// ── Errors: FastAPI code only, never the message or the URL ─────────────────────────────────────

test("4xx returns rejected with FastAPI's error code, not its message", async () => {
  const { fetchImpl } = stubFetch(422, {
    error: { code: "validation_error", message: "phone +77071234567 is wrong", details: [] },
  });
  const err = await rejects(postBirthdayLead(clientWith(fetchImpl), { name: "Айжан", phone: "+77071234567", branchId: "b" }));
  assert.equal(err.kind, "rejected");
  assert.equal(err.status, 422);
  assert.equal(err.code, "validation_error");
  assert.ok(!err.message.includes("77071234567"), "error text must not echo the phone");
});

test("5xx is unavailable", async () => {
  const { fetchImpl } = stubFetch(503, { error: { code: "down", message: "x" } });
  const err = await rejects(requestOtp(clientWith(fetchImpl), { phone: "+77071234567" }));
  assert.equal(err.kind, "unavailable");
  assert.equal(err.status, 503);
});

test("network failure is unavailable and drops the original message", async () => {
  const fetchImpl = async () => {
    throw new TypeError(`connect ECONNREFUSED ${BASE}`);
  };
  const err = await rejects(requestOtp(clientWith(fetchImpl), { phone: "+77071234567" }));
  assert.equal(err.kind, "unavailable");
  assert.ok(!err.message.includes("example.kz"));
});

test("timeout is reported as timeout, not as a generic failure", async () => {
  const fetchImpl = async () => {
    const e = new Error("The operation timed out.");
    e.name = "TimeoutError";
    throw e;
  };
  const err = await rejects(requestOtp(clientWith(fetchImpl), { phone: "+77071234567" }));
  assert.equal(err.kind, "timeout");
});

// ── Log safety and redaction ───────────────────────────────────────────────────────────────────

test("log lines carry route template and outcome, never the phone or name", async () => {
  const { fetchImpl } = stubFetch(422, { error: { code: "validation_error", message: "bad" } });
  const logs: FastapiLogLine[] = [];
  await rejects(postContactLead(clientWith(fetchImpl, logs), { name: "Айжан Тест", phone: "+77071234567" }));
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("77071234567"));
  assert.ok(!text.includes("Айжан"));
  assert.equal(logs[0].outcome, "rejected");
  assert.equal(logs[0].route, "/mobile/leads/contact");
});

test("redact removes personal and secret keys recursively", () => {
  const out = redact({
    name: "Айжан",
    phone: "+77071234567",
    nested: { comment: "секрет", access_token: "abc", keep: 5 },
    list: [{ email: "a@b.kz", status: "new" }],
  });
  assert.deepEqual(out, {
    name: "[redacted]",
    phone: "[redacted]",
    nested: { comment: "[redacted]", access_token: "[redacted]", keep: 5 },
    list: [{ email: "[redacted]", status: "new" }],
  });
});

test("correlation id: plain incoming id is kept, junk is replaced", () => {
  assert.equal(correlationId("abc-12345678", () => "new"), "abc-12345678");
  assert.equal(correlationId("bad id\nwith space", () => "new"), "new");
  assert.equal(correlationId(null, () => "new"), "new");
});
