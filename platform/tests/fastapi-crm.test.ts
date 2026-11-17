import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bridgeExport, bridgeImage, bridgeImageUpload } from "../src/server/bridge-client.ts";
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

  it("uses the bb.* bridge in Vercel mode without DATABASE_URL or a FastAPI URL", async () => {
    const keys = ["UNIFIED_FASTAPI_CRM_ENABLED", "CRM_BRIDGE_MODE", "CRM_BRIDGE_URL", "CRM_SERVICE_TOKEN", "DATABASE_URL", "FASTAPI_ADMIN_BASE_URL"] as const;
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.CRM_BRIDGE_MODE = "legacy";
    process.env.CRM_BRIDGE_URL = "https://api.example.test";
    process.env.CRM_SERVICE_TOKEN = "s".repeat(40);
    delete process.env.DATABASE_URL;
    delete process.env.FASTAPI_ADMIN_BASE_URL;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url, init });
      return requests.length === 1
        ? Response.json({ branches: [], rooms: [], packages: [] })
        : new Response("csv-bytes", { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=boombala-contacts-test.csv" } });
    }) as typeof fetch;
    try {
      const client = new FastApiCrmClient({ accessToken: "opaque-platform-session-token" });
      assert.deepEqual(await client.getBookingCatalog(), { branches: [], rooms: [], packages: [] });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://api.example.test/api/bridge/rpc");
      const headers = new Headers(requests[0].init.headers);
      assert.equal(headers.get("authorization"), "Bearer opaque-platform-session-token");
      assert.equal(headers.get("x-crm-service-token"), "s".repeat(40));
      assert.deepEqual(JSON.parse(String(requests[0].init.body)), { op: "calendar.catalog", input: {} });
      const exported = await bridgeExport({ format: "csv", columns: ["name"] }, "opaque-platform-session-token");
      assert.equal(await exported.text(), "csv-bytes");
      assert.equal(requests[1].url, "https://api.example.test/api/bridge/export");
      assert.equal(new Headers(requests[1].init.headers).get("accept"), "application/octet-stream");
      assert.equal(new Headers(requests[1].init.headers).get("authorization"), "Bearer opaque-platform-session-token");

      await bridgeImageUpload(new File(["synthetic-image-bytes"], "synthetic.png", { type: "image/png" }), "Synthetic image", "opaque-platform-session-token");
      assert.equal(requests[2].url, "https://api.example.test/api/bridge/media");
      assert.ok(requests[2].init.body instanceof FormData);
      assert.equal(new Headers(requests[2].init.headers).get("content-type"), null, "fetch must set the multipart boundary");
      const image = await bridgeImage("00000000-0000-4000-8000-000000000001", "opaque-platform-session-token");
      assert.equal(await image.text(), "csv-bytes");
      assert.equal(requests[3].url, "https://api.example.test/api/bridge/media/00000000-0000-4000-8000-000000000001");
      assert.equal(new Headers(requests[3].init.headers).get("accept"), "image/webp");
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(process.env.FASTAPI_ADMIN_BASE_URL, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of keys) {
        const value = before[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
