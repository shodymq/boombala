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
    await client.confirmBooking({ requestId: "lead-1", bookingDate: "2099-05-15", roomId: "room-1", startTime: "12:00", packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/api/v1/admin/birthday-bookings/confirm");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer staff-access-token");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "crm-request-1");
    assert.equal(calls[0].init.body, JSON.stringify({ requestId: "lead-1", bookingDate: "2099-05-15", roomId: "room-1", startTime: "12:00", packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001" }));
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

  it("fails closed when a birthday detail omits reservation state", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify({ id: "lead-1" }), { status: 200 }),
    });

    await assert.rejects(
      () => client.getBirthdayLead("lead-1"),
      (error) => error instanceof FastApiCrmError && error.code === "birthday_reservation_state_invalid",
    );
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("fails payment readback when the saved manual method differs", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const receivedAt = "2026-11-10T10:00:00Z";
    const responses = [
      {
        id: "payment-1", requestId: "lead-1", amountKzt: 10000, paymentKind: "initial_deposit",
        method: "cash", receivedAt, recordedByAdminId: "admin-1", source: "manager_manual",
        idempotencyKey: "payment-0001", createdAt: receivedAt,
      },
      {
        id: "lead-1", bookingReservationState: "none", manualPaymentFacts: [{
          id: "payment-1", amountKzt: 10000, paymentKind: "initial_deposit", method: "bank_transfer",
          receivedAt, recordedByAdminId: "admin-1", recordedByAdminName: "QA Manager", note: null,
          source: "manager_manual", createdAt: receivedAt,
        }],
      },
    ];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    await assert.rejects(
      () => client.recordManualPaymentAndRead("lead-1", {
        amountKzt: 10000, paymentKind: "initial_deposit", method: "cash",
        receivedAt, idempotencyKey: "payment-0001",
      }),
      (error) => error instanceof FastApiCrmError && error.code === "payment_readback_mismatch",
    );
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("fails refund readback when the saved reason differs", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const refundedAt = "2026-11-10T10:00:00Z";
    const responses = [
      {
        id: "refund-1", requestId: "lead-1", paymentFactId: "payment-1", amountKzt: 5000,
        method: "cash", refundedAt, recordedByAdminId: "admin-1", reason: "Parent requested",
        source: "manager_manual", idempotencyKey: "refund-0001", createdAt: refundedAt,
      },
      {
        id: "lead-1", bookingReservationState: "none", manualRefundFacts: [{
          id: "refund-1", requestId: "lead-1", paymentFactId: "payment-1", amountKzt: 5000,
          method: "cash", refundedAt, recordedByAdminId: "admin-1", reason: "Different saved reason",
          source: "manager_manual", idempotencyKey: "refund-0001", createdAt: refundedAt,
        }],
      },
    ];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    await assert.rejects(
      () => client.recordManualRefundAndRead("lead-1", {
        amountKzt: 5000, paymentFactId: "payment-1", method: "cash", refundedAt,
        idempotencyKey: "refund-0001", reason: "Parent requested",
      }),
      (error) => error instanceof FastApiCrmError && error.code === "refund_readback_mismatch",
    );
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
        if (paths.length === 1) return new Response(JSON.stringify({
          id: "booking-1", kind: "booking", status: "confirmed", requestId: "lead-1", branchId: "branch-1",
          bookingDate: "2026-11-10", roomId: "room-1", slotId: null, startsAt: "2026-11-10T12:00:00+06:00",
          endsAt: "2026-11-10T16:00:00+06:00", packageId: "package-1", priceKzt: 200000,
          priceSource: "manager_agreed", note: null, releasedAt: null,
        }), { status: 200 });
        return new Response(JSON.stringify({ error: { code: "slot_taken" } }), { status: 409 });
      },
    });
    await assert.rejects(
      () => client.confirmBookingAndRead({ requestId: "lead-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "12:00", packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001" }, { workingHours: "10:00-22:00", bufferMinutes: 0 }),
      (error) => error instanceof FastApiCrmError && error.status === 409 && error.code === "slot_taken",
    );
    assert.deepEqual(paths, ["/api/v1/admin/birthday-bookings/confirm", "/api/v1/admin/leads/lead-1/birthday"]);
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("accepts zero-buffer booking readback only when the room is occupied for exactly four hours", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const booking = {
      id: "booking-1", kind: "booking", status: "confirmed", requestId: "lead-1", branchId: "branch-1",
      bookingDate: "2026-11-10", roomId: "room-1", slotId: null, startsAt: "2026-11-10T12:00:00+06:00",
      endsAt: "2026-11-10T16:00:00+06:00", packageId: "package-1", priceKzt: 200000,
      priceSource: "manager_agreed", note: null, releasedAt: null,
    };
    const lead = {
      id: "lead-1", status: "booked", bookingReservationState: "active", netInitialDepositKzt: 10000, manualPaymentFactStatus: "prepaid",
      branch: { id: "branch-1", name: "Алматы", shortLabel: "ALM" },
    };
    const reservation = {
      id: "booking-1", kind: "booking", status: "confirmed", requestId: "lead-1", roomId: "room-1",
      startsAt: booking.startsAt, endsAt: booking.endsAt, occupiedEndsAt: booking.endsAt,
    };
    const responses = [booking, lead, {
      branchId: "branch-1", date: "2026-11-10", timezone: "Asia/Almaty", bufferMinutes: 0,
      rooms: [{ id: "room-1", name: "Room 1" }], reservations: [reservation],
    }];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    await assert.doesNotReject(() => client.confirmBookingAndRead({
      requestId: "lead-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "12:00",
      packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0001",
    }, { workingHours: "10:00-22:00", bufferMinutes: 0 }));

    const extendedReservation = { ...reservation, occupiedEndsAt: "2026-11-10T16:30:00+06:00" };
    const invalidResponses = [booking, lead, {
      branchId: "branch-1", date: "2026-11-10", timezone: "Asia/Almaty", bufferMinutes: 0,
      rooms: [{ id: "room-1", name: "Room 1" }], reservations: [extendedReservation],
    }];
    const invalidClient = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => new Response(JSON.stringify(invalidResponses.shift()), { status: 200 }),
    });
    await assert.rejects(
      () => invalidClient.confirmBookingAndRead({
        requestId: "lead-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "12:00",
        packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0002",
      }, { workingHours: "10:00-22:00", bufferMinutes: 0 }),
      (error) => error instanceof FastApiCrmError && error.code === "booking_timeline_readback_mismatch",
    );

    const invalidBookingClient = new FastApiCrmClient({ accessToken: "staff-access-token" }, {
      fetchImpl: async () => { throw new Error("booking request must not be sent"); },
    });
    await assert.rejects(
      () => invalidBookingClient.confirmBookingAndRead({
        requestId: "lead-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "15:30",
        packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0003",
      }, { workingHours: "10:00-22:00", bufferMinutes: 0 }),
      (error) => error instanceof FastApiCrmError && error.code === "booking_time_outside_working_hours",
    );
    await assert.rejects(
      () => invalidBookingClient.confirmBookingAndRead({
        requestId: "lead-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "10:00",
        packageId: "package-1", agreedPriceKzt: 200000, idempotencyKey: "confirm-0004",
      }, { workingHours: "10:00-22:00", bufferMinutes: 30 }),
      (error) => error instanceof FastApiCrmError && error.code === "booking_buffer_required",
    );

    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });

  it("calls the manual refund, booking catalog and birthday slot block endpoints", async () => {
    const beforeFlag = process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    const beforeBaseUrl = process.env.FASTAPI_ADMIN_BASE_URL;
    process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
    process.env.FASTAPI_ADMIN_BASE_URL = "https://api.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      { id: "refund-1", requestId: "lead-1", paymentFactId: "payment-1", amountKzt: 10000, method: "cash", refundedAt: "2026-11-03T10:00:00Z", recordedByAdminId: "manager-1", reason: "Event cancelled", source: "manager_manual", idempotencyKey: "refund-key-0001", createdAt: "2026-11-03T10:00:00Z" },
      { branches: [], rooms: [], packages: [] },
      { id: "reservation-1", kind: "block", status: "blocked", requestId: null, branchId: "branch-1", bookingDate: "2026-11-10", roomId: "room-1", slotId: null, startsAt: "2026-11-10T12:00:00+05:00", endsAt: "2026-11-10T16:00:00+05:00", packageId: null, priceKzt: null, priceSource: null, note: "Maintenance", releasedAt: null },
    ];
    const client = new FastApiCrmClient({ accessToken: "staff-access-token", requestId: "crm-request-3" }, {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(responses[calls.length - 1]), { status: 200 });
      },
    });
    const refundBody = { amountKzt: 10000, paymentFactId: "payment-1", method: "cash" as const, refundedAt: "2026-11-03T10:00:00Z", idempotencyKey: "refund-key-0001", reason: "Event cancelled" };
    await client.recordManualRefund("lead-1", refundBody);
    await client.getBookingCatalog("branch-1");
    await client.blockBirthdaySlot({ branchId: "branch-1", bookingDate: "2026-11-10", roomId: "room-1", startTime: "12:00", reason: "Maintenance", idempotencyKey: "block-key-0001" });

    assert.deepEqual(calls.map(({ url }) => url), [
      "https://api.example.test/api/v1/admin/birthday-requests/lead-1/manual-refunds",
      "https://api.example.test/api/v1/admin/birthday-bookings/catalog?branchId=branch-1",
      "https://api.example.test/api/v1/admin/birthday-slots/block",
    ]);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify(refundBody));
    assert.equal(calls[2].init.method, "POST");
    assert.equal(new Headers(calls[2].init.headers).get("authorization"), "Bearer staff-access-token");
    if (beforeBaseUrl === undefined) delete process.env.FASTAPI_ADMIN_BASE_URL;
    else process.env.FASTAPI_ADMIN_BASE_URL = beforeBaseUrl;
    if (beforeFlag === undefined) delete process.env.UNIFIED_FASTAPI_CRM_ENABLED;
    else process.env.UNIFIED_FASTAPI_CRM_ENABLED = beforeFlag;
  });
});
