import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { canRetryWithSameIdempotencyKey, FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, hasSingleBranchFourRoomSetup, unifiedFastapiCrmEnabled } from "../src/server/fastapi-crm.ts";

describe("FastAPI CRM adapter", () => {
  it("keeps an idempotency key when a write outcome is unknown", () => {
    assert.equal(canRetryWithSameIdempotencyKey(new TypeError("fetch failed")), true);
    assert.equal(canRetryWithSameIdempotencyKey(new z.ZodError([])), true);
    assert.equal(canRetryWithSameIdempotencyKey(new FastApiCrmError(503, "unavailable", "request-1")), true);
    assert.equal(canRetryWithSameIdempotencyKey(new FastApiCrmError(409, "time_conflict", "request-2")), false);
    assert.equal(canRetryWithSameIdempotencyKey(new FastApiCrmError(403, "forbidden", "request-3")), false);
  });

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
          return new Response(JSON.stringify({ id: "booking-1", kind: "booking", status: "confirmed" }), { status: 200, headers: { "content-type": "application/json" } });
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

  it("reads FastAPI leads with the authenticated staff token", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const item = {
      id: "lead-1",
      type: "birthday_request",
      summary: "День рождения",
      status: "new",
      source: "website",
      customerName: "Айжан",
      phone: "+77071234567",
      guestCount: 4,
      requestedDate: "2027-01-20",
      createdAt: "2026-10-31T10:00:00Z",
      branch: { id: "branch-1", name: "Алматы", shortLabel: "ALM" },
      package: { id: "package-1", name: "Wow Party" },
    };
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-request-2" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ items: [item], total: 1 }), { status: 200 });
      },
    });
    const result = await client.listLeads({ status: "new", q: "Айжан", createdFrom: "2026-10-01", createdTo: "2026-10-31" });
    assert.deepEqual(result, { items: [item], total: 1 });
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/leads?status=new&q=%D0%90%D0%B9%D0%B6%D0%B0%D0%BD&createdFrom=2026-10-01&createdTo=2026-10-31");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer staff-access-token");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "crm-request-2");
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
        if (paths.length === 1) return new Response(JSON.stringify({ id: "booking-1", kind: "booking", status: "confirmed" }), { status: 200 });
        return new Response(JSON.stringify({ error: { code: "slot_taken" } }), { status: 409 });
      },
    });
    await assert.rejects(
      () => client.confirmBookingAndRead({
        requestId: "lead-1", bookingDate: "2099-05-15", roomId: "room-1", startTime: "10:00",
        idempotencyKey: "confirm-0001",
      }),
      (error) => error instanceof FastApiCrmError && error.status === 409 && error.code === "slot_taken",
    );
    assert.deepEqual(paths, ["/api/v1/admin/birthday-bookings/confirm", "/api/v1/admin/leads/lead-1/birthday"]);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("confirms a booking only after the lead and room timeline show the saved booking", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const paths: string[] = [];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/birthday-bookings/confirm")) {
          return new Response(JSON.stringify({ id: "reservation-1", kind: "booking", status: "confirmed" }), { status: 200 });
        }
        if (path.endsWith("/birthday")) {
          return new Response(JSON.stringify({
            id: "request-1", status: "booked", source: "website", customerName: "Parent", phone: "+77070000000",
            contactMethod: "phone", branch: { id: "branch-1", name: "Алматы", shortLabel: "ALM" },
            manualPaymentFacts: [], manualRefundFacts: [], manualRefundFactAmountKzt: 0,
            netManualPaymentAmountKzt: 10000, netInitialDepositKzt: 10000, manualPaymentFactAmountKzt: 10000,
            manualPaymentFactStatus: "prepaid", createdAt: "2026-10-31T10:00:00Z",
            agreedAmountTenge: 180000,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          branchId: "branch-1", date: "2026-11-15", timezone: "Asia/Almaty", bufferMinutes: 30,
          rooms: [{ id: "room-1", name: "Комната" }],
          reservations: [{
            id: "reservation-1", kind: "booking", status: "confirmed", roomId: "room-1",
            startsAt: "2026-11-15T10:00:00+05:00", endsAt: "2026-11-15T14:00:00+05:00",
            occupiedEndsAt: "2026-11-15T14:30:00+05:00", slotId: null, packageName: "Party",
            priceKzt: 180000, priceSource: "manager_agreed", paidKzt: 10000, paymentStatus: "prepaid",
            note: null, requestId: "request-1", customerName: "Parent", customerPhone: "+77070000000",
            createdByAdminId: "staff-1", createdByName: "Manager",
          }],
        }), { status: 200 });
      },
    });

    const result = await client.confirmBookingAndRead({
      requestId: "request-1", bookingDate: "2026-11-15", roomId: "room-1", startTime: "10:00",
      packageId: "package-1", agreedPriceKzt: 180000, idempotencyKey: "confirm-1",
    });

    assert.equal(result.booking.id, "reservation-1");
    assert.deepEqual(paths, [
      "/api/v1/admin/birthday-bookings/confirm",
      "/api/v1/admin/leads/request-1/birthday",
      "/api/v1/admin/birthday-bookings/timeline",
    ]);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("does not acknowledge a manual payment missing from the saved lead facts", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    let call = 0;
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({
            id: "payment-1", requestId: "request-1", amountKzt: 10000, method: "cash",
            receivedAt: "2026-10-31T10:00:00Z", source: "manager_manual", idempotencyKey: "payment-1",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: "request-1", status: "new", source: "website", customerName: "Parent", phone: "+77070000000",
          contactMethod: "phone", manualPaymentFacts: [], manualRefundFacts: [], manualRefundFactAmountKzt: 0,
          netManualPaymentAmountKzt: 0, netInitialDepositKzt: 0, manualPaymentFactAmountKzt: 0,
          manualPaymentFactStatus: "unpaid", createdAt: "2026-10-31T10:00:00Z",
        }), { status: 200 });
      },
    });

    await assert.rejects(
      () => client.recordManualPaymentAndRead("request-1", {
        amountKzt: 10000, method: "cash", idempotencyKey: "payment-1",
      }),
      (error) => error instanceof FastApiCrmError && error.code === "payment_readback_mismatch",
    );

    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("validates the single-branch catalog and complete timeline including buffer occupancy", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const paths: string[] = [];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/catalog")) {
          return new Response(JSON.stringify({
            branches: [{ id: "branch-1", slug: "almaty", name: "Алматы", city: "Алматы", workingHours: "10:00–22:00", bufferMinutes: 30 }],
            rooms: ["room-1", "room-2", "room-3", "room-4"].map((id) => ({ id, branchId: "branch-1", name: id })),
            packages: [{ id: "package-1", branchId: "branch-1", name: "Party", priceFrom: 40000, priceLabel: "от 40 000 ₸", guestCapacityLabel: "до 12 гостей" }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          branchId: "branch-1", date: "2026-11-01", timezone: "Asia/Almaty", bufferMinutes: 30,
          rooms: [{ id: "room-1", name: "Roblox Room" }],
          reservations: [{
            id: "reservation-1", kind: "booking", status: "confirmed", roomId: "room-1",
            startsAt: "2026-11-01T10:00:00+05:00", endsAt: "2026-11-01T14:00:00+05:00", occupiedEndsAt: "2026-11-01T14:30:00+05:00",
            slotId: null, packageName: "Party", priceKzt: 50000, priceSource: "manager_agreed", paidKzt: 10000,
            paymentStatus: "prepaid", note: null, requestId: "request-1", customerName: null, customerPhone: null,
            createdByAdminId: "staff-1", createdByName: "Менеджер",
          }],
        }), { status: 200 });
      },
    });
    const catalog = await client.getBookingCatalog();
    const timeline = await client.getBookingTimeline("branch-1", "2026-11-01");
    assert.equal(catalog.branches.length, 1);
    assert.equal(hasSingleBranchFourRoomSetup(catalog, "branch-1"), true);
    assert.equal(hasSingleBranchFourRoomSetup(catalog, "branch-2"), false);
    assert.equal(hasSingleBranchFourRoomSetup({ ...catalog, branches: [...catalog.branches, { ...catalog.branches[0], id: "branch-2" }] }), false);
    assert.equal(catalog.packages[0].priceFrom, 40000);
    assert.equal(timeline.bufferMinutes, 30);
    assert.equal(timeline.reservations[0].occupiedEndsAt, "2026-11-01T14:30:00+05:00");
    assert.equal(timeline.reservations[0].paymentStatus, "prepaid");
    assert.deepEqual(paths, ["/api/v1/admin/birthday-bookings/catalog", "/api/v1/admin/birthday-bookings/timeline"]);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("reads CRM booking, payment and refund audit events with the staff token", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const event = {
      id: "audit-1", action: "payment.recorded", entityType: "payment", entityId: "request-1",
      requestId: "request-1", branchId: "branch-1", actorId: "staff-1", actorName: "Менеджер",
      createdAt: "2026-10-31T10:00:00Z", after: { amountKzt: 10000, method: "cash" },
    };
    const leadEvent = {
      id: "audit-2", action: "lead.status_changed", entityType: "lead", entityId: "request-1",
      requestId: "request-1", branchId: "branch-1", actorId: "staff-1", actorName: "Менеджер",
      createdAt: "2026-10-31T10:01:00Z", before: { status: "new" }, after: { status: "contacted" },
    };
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-audit-1" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify([event, leadEvent]), { status: 200 });
      },
    });
    const result = await client.listBirthdayBookingAudit();
    assert.equal(result[0].action, "payment.recorded");
    assert.equal(result[0].actorName, "Менеджер");
    assert.equal(result[1].entityType, "lead");
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/birthday-bookings/audit?limit=100");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer staff-access-token");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "crm-audit-1");
    assert.equal(JSON.stringify(result).includes("idempotencyKey"), false);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("records an actual refund through FastAPI with the staff token and idempotency key", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-refund-1" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          id: "refund-1", requestId: "lead-1", amountKzt: 5000, method: "bank_transfer",
          refundedAt: "2026-10-31T09:00:00Z", recordedByAdminId: "admin-1", reason: "Event cancelled",
          source: "manager_manual", idempotencyKey: "refund-key-1", createdAt: "2026-10-31T10:00:00Z",
        }), { status: 200 });
      },
    });
    const result = await client.recordManualRefund("lead-1", {
      amountKzt: 5000, method: "bank_transfer", refundedAt: "2026-10-31T09:00:00Z",
      reason: "Event cancelled", idempotencyKey: "refund-key-1",
    });
    assert.equal(result.recordedByAdminId, "admin-1");
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/birthday-requests/lead-1/manual-refunds");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer staff-access-token");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "crm-refund-1");
    assert.equal(calls[0].init.body, JSON.stringify({
      amountKzt: 5000, method: "bank_transfer", refundedAt: "2026-10-31T09:00:00Z",
      reason: "Event cancelled", idempotencyKey: "refund-key-1",
    }));
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("reads and edits the one-branch birthday package catalog through FastAPI", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const summary = {
      id: "package-1", branch_id: "branch-1", slug: "wow-party", name: "Wow Party",
      price_from: 40000, price_label: "от 40 000 ₸", guest_capacity_label: "до 12 гостей",
      image_url: null, is_featured: true, is_active: true, display_order: 1,
    };
    const detail = { ...summary, description: "Праздничный пакет для всей семьи.", highlights: ["Декор"] };
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-catalog-1" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const path = new URL(String(url)).pathname;
        const body = path.endsWith("/birthday-packages") && (init.method ?? "GET") === "GET" ? [summary] : detail;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const packages = await client.listAdminBirthdayPackages("branch-1");
    const loaded = await client.getAdminBirthdayPackage("package-1");
    await client.updateAdminBirthdayPackage("package-1", { price_from: 42000 });
    await client.createAdminBirthdayPackage({
      branch_id: "branch-1", slug: "wow-party", name: "Wow Party", price_from: 40000,
      price_label: "от 40 000 ₸", guest_capacity_label: "до 12 гостей",
      description: "Праздничный пакет для всей семьи.", highlights: ["Декор"],
      image_url: null, is_featured: true, is_active: true, display_order: 1,
    });
    assert.equal(packages[0].branchId, "branch-1");
    assert.equal(packages[0].priceFrom, 40000);
    assert.deepEqual(loaded.highlights, ["Декор"]);
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/birthday-packages?branch_id=branch-1&include_inactive=true");
    assert.deepEqual(calls.slice(1).map((call) => new URL(call.url).pathname), [
      "/api/v1/admin/birthday-packages/package-1",
      "/api/v1/admin/birthday-packages/package-1",
      "/api/v1/admin/birthday-packages",
    ]);
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), { price_from: 42000 });
    assert.deepEqual(JSON.parse(String(calls[3].init.body)), {
      branch_id: "branch-1", slug: "wow-party", name: "Wow Party", price_from: 40000,
      price_label: "от 40 000 ₸", guest_capacity_label: "до 12 гостей",
      description: "Праздничный пакет для всей семьи.", highlights: ["Декор"],
      image_url: null, is_featured: true, is_active: true, display_order: 1,
    });
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("reads blocks, releases and reschedules back from the FastAPI timeline", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reservation = (id: string, kind: "booking" | "block", status: "confirmed" | "blocked" | "released", roomId: string, startsAt: string) => ({
      id, kind, status, roomId, startsAt, endsAt: startsAt, occupiedEndsAt: startsAt,
      slotId: null, packageName: null, priceKzt: null, priceSource: null, paidKzt: 0,
      paymentStatus: "unpaid" as const, note: null, requestId: null, customerName: null,
      customerPhone: null, createdByAdminId: "staff-1", createdByName: "Менеджер",
    });
    const timeline = (date: string, item: ReturnType<typeof reservation>) => ({
      branchId: "branch-1", date, timezone: "Asia/Almaty", bufferMinutes: 30,
      rooms: [{ id: item.roomId, name: "Комната" }], reservations: [item],
    });
    const responses = [
      { id: "block-1", kind: "block", status: "blocked" },
      timeline("2026-11-03", reservation("block-1", "block", "blocked", "room-1", "2026-11-03T12:00:00+05:00")),
      { id: "booking-1", kind: "booking", status: "released" },
      timeline("2026-11-03", reservation("booking-1", "booking", "released", "room-1", "2026-11-03T10:00:00+05:00")),
      { id: "booking-2", kind: "booking", status: "confirmed" },
      timeline("2026-11-04", reservation("booking-2", "booking", "confirmed", "room-2", "2026-11-04T14:00:00+05:00")),
    ];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-reservation-1" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(responses[calls.length - 1]), { status: 200 });
      },
    });

    await client.blockBookingSlotAndRead({ branchId: "branch-1", bookingDate: "2026-11-03", roomId: "room-1", startTime: "12:00", reason: "Maintenance", idempotencyKey: "block-key" });
    await client.releaseReservationAndRead("booking-1", "branch-1", "2026-11-03", { reason: "Cancelled", idempotencyKey: "release-key" });
    await client.rescheduleReservationAndRead("booking-2", "branch-1", { bookingDate: "2026-11-04", roomId: "room-2", startTime: "14:00", idempotencyKey: "move-key" });

    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      "/api/v1/admin/birthday-slots/block",
      "/api/v1/admin/birthday-bookings/timeline",
      "/api/v1/admin/birthday-reservations/booking-1/release",
      "/api/v1/admin/birthday-bookings/timeline",
      "/api/v1/admin/birthday-reservations/booking-2/reschedule",
      "/api/v1/admin/birthday-bookings/timeline",
    ]);
    assert.equal(JSON.parse(String(calls[0].init.body)).idempotencyKey, "block-key");
    assert.equal(JSON.parse(String(calls[2].init.body)).idempotencyKey, "release-key");
    assert.equal(JSON.parse(String(calls[4].init.body)).idempotencyKey, "move-key");
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("keeps a retryable error when the rescheduled reservation is not visible yet", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    let call = 0;
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-reservation-2" }, {
      fetchImpl: async () => {
        call += 1;
        const body = call === 1
          ? { id: "booking-2", kind: "booking", status: "confirmed" }
          : { branchId: "branch-1", date: "2026-11-04", timezone: "Asia/Almaty", bufferMinutes: 30, rooms: [{ id: "room-1", name: "Комната" }], reservations: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    await assert.rejects(
      () => client.rescheduleReservationAndRead("booking-2", "branch-1", { bookingDate: "2026-11-04", roomId: "room-2", startTime: "14:00", idempotencyKey: "move-key" }),
      (error) => error instanceof FastApiCrmError && error.status === 502 && canRetryWithSameIdempotencyKey(error),
    );
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("rejects a malformed FastAPI calendar instead of treating it as free availability", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify({ branchId: "branch-1", date: "2026-11-01", rooms: [], reservations: [] }), { status: 200 }),
    });
    await assert.rejects(() => client.getBookingTimeline("branch-1", "2026-11-01"));
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });
});
