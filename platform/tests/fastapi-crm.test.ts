import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../src/server/fastapi-crm.ts";

describe("FastAPI CRM adapter", () => {
  it("is disabled unless the explicit server-side flag is set", () => {
    const before = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    assert.equal(unifiedFastapiCrmEnabled(), false);
    assert.throws(
      () => new FastApiCrmClient({ accessToken: "token" }),
      (error) => error instanceof FastApiCrmConfigurationError && error.message === "crm_flag_disabled",
    );
    if (before === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = before;
  });

  it("sends the staff bearer, correlation id and exact mutation body server-side", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new FastApiCrmClient(
      { accessToken: "staff-access-token", requestId: "crm-request-1" },
      {
        fetchImpl: async (url, init = {}) => {
          const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
          calls.push({ url: urlText, init });
          return new Response(JSON.stringify({ id: "booking-1", status: "confirmed" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );
    await client.confirmBooking({ requestId: "lead-1", bookingDate: "2099-05-15", roomId: "room-1", slotId: "slot-1", packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/birthday-bookings/confirm");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer staff-access-token");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "crm-request-1");
    assert.equal(calls[0].init.body, JSON.stringify({ requestId: "lead-1", bookingDate: "2099-05-15", roomId: "room-1", slotId: "slot-1", packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001" }));
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("performs read-after-write and exposes FastAPI errors without a legacy fallback", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const paths: string[] = [];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async (url) => {
        const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        paths.push(new URL(urlText).pathname);
        if (paths.length === 1) return new Response(JSON.stringify({ id: "booking-1" }), { status: 200 });
        return new Response(JSON.stringify({ error: { code: "slot_taken" } }), { status: 409 });
      },
    });
    await assert.rejects(
      () => client.confirmBookingAndRead({ requestId: "lead-1", idempotencyKey: "confirm-0001" }),
      (error) => error instanceof FastApiCrmError && error.status === 409 && error.code === "slot_taken",
    );
    assert.deepEqual(paths, ["/api/v1/admin/birthday-bookings/confirm", "/api/v1/admin/leads/lead-1/birthday"]);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });
});
