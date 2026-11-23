import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildUpcomingBirthdayOperations, upcomingOperationDates, type OperationsReadRow } from "../src/core/operations-overview.ts";

const baseNow = new Date("2026-11-22T08:00:00.000Z"); // 13:00 in Almaty.

function row(overrides: Partial<OperationsReadRow> = {}): OperationsReadRow {
  return {
    id: "reservation-1",
    date: "2026-11-22",
    kind: "booking",
    status: "confirmed",
    startsAt: "2026-11-22T09:00:00.000Z", // 14:00 in Almaty.
    room: "Ice Room",
    packageName: "STAR PARTY",
    paymentStatus: "prepaid",
    paidKzt: 10000,
    sourceState: null,
    card: {
      programStatus: "approved",
      propsStatus: "ready",
      invitationStatus: "sent",
      responsibleName: "Synthetic Manager",
    },
    ...overrides,
  };
}

describe("upcoming birthday operations projection", () => {
  it("produces exactly seven Almaty calendar dates across month/year boundaries", () => {
    assert.deepEqual(upcomingOperationDates("2026-12-28"), [
      "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
    ]);
    assert.throws(() => upcomingOperationDates("2026-02-31"), /invalid_operations_date/);
  });

  it("shows future confirmed bookings and linked Sheets blocks as separate record types", () => {
    const result = buildUpcomingBirthdayOperations([
      row(),
      row({ id: "sheets-block", kind: "block", status: "blocked", sourceState: "active", paymentStatus: "prepaid", paidKzt: 10000, card: null }),
      row({ id: "missing-source", kind: "block", status: "blocked", sourceState: "source_missing", card: null }),
      row({ id: "unlinked-block", kind: "block", status: "blocked", sourceState: null, card: null }),
      row({ id: "released", status: "released" }),
      row({ id: "past", startsAt: "2026-11-22T07:59:00.000Z" }),
      row({ id: "outside-range", date: "2026-11-29", startsAt: "2026-11-29T09:00:00.000Z" }),
      row({ id: "date-mismatch", startsAt: "2026-11-23T07:00:00.000Z" }),
    ], baseNow);
    assert.deepEqual(result.map((item) => item.id), ["missing-source", "reservation-1", "sheets-block"]);
    const byId = new Map(result.map((item) => [item.id, item]));
    assert.equal(byId.get("reservation-1")?.recordStatus, "confirmed");
    assert.equal(byId.get("sheets-block")?.recordStatus, "manual_review");
    assert.equal(byId.get("sheets-block")?.paymentFact.status, "not_recorded", "a sheet's prepayment cell is not a financial fact");
    assert.equal(byId.get("sheets-block")?.responsibleManager, null);
    assert.equal(byId.get("missing-source")?.recordStatus, "source_missing");
  });

  it("shows only a positive recorded manual-payment fact on a confirmed booking", () => {
    const result = buildUpcomingBirthdayOperations([
      row(),
      row({ id: "unpaid", paymentStatus: "unpaid", paidKzt: 0 }),
      row({ id: "inconsistent", paymentStatus: "prepaid", paidKzt: 0 }),
    ], baseNow);
    const byId = new Map(result.map((item) => [item.id, item]));
    assert.deepEqual(byId.get("reservation-1")?.paymentFact, { status: "confirmed", amountKzt: 10000 });
    assert.deepEqual(byId.get("unpaid")?.paymentFact, { status: "not_recorded" });
    assert.deepEqual(byId.get("inconsistent")?.paymentFact, { status: "not_recorded" });
  });

  it("preserves readiness states and omits invitation when it is not applicable", () => {
    const result = buildUpcomingBirthdayOperations([
      row(),
      row({ id: "no-invite", card: { ...row().card!, invitationStatus: "not_applicable" } }),
      row({ id: "no-card", card: null }),
    ], baseNow);
    const byId = new Map(result.map((item) => [item.id, item]));
    assert.equal(byId.get("reservation-1")?.programStatus, "approved");
    assert.equal(byId.get("reservation-1")?.propsStatus, "ready");
    assert.equal(byId.get("reservation-1")?.invitationStatus, "sent");
    assert.equal(byId.get("no-invite")?.invitationStatus, "not_applicable");
    assert.equal(byId.get("no-card")?.responsibleManager, null);
    assert.equal(byId.get("no-card")?.programStatus, null);
    assert.equal(byId.get("no-card")?.propsStatus, null);
    assert.equal(byId.get("no-card")?.invitationStatus, null);
  });

  it("drops unexpected customer, child, and note fields before returning renderable data", () => {
    const syntheticPhoneCanary = "SYNTHETIC_PHONE_CANARY";
    const unsafeFixture = {
      ...row(),
      customerName: "Synthetic Customer Name",
      customerPhone: syntheticPhoneCanary,
      childName: "Synthetic Child",
      note: "Synthetic private note",
      sourcePayload: { phone: syntheticPhoneCanary, child: "Synthetic Child" },
    } as OperationsReadRow;
    const result = buildUpcomingBirthdayOperations([unsafeFixture], baseNow);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["Synthetic Customer Name", syntheticPhoneCanary, "Synthetic Child", "Synthetic private note"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "date", "id", "invitationStatus", "packageName", "paymentFact", "programStatus", "propsStatus", "recordStatus", "responsibleManager", "room", "startsAt",
    ]);
  });
});

describe("operations page access and read path", () => {
  const page = readFileSync(new URL("../src/app/(admin)/operations/page.tsx", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../src/server/legacy-bridge.ts", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../src/app/(admin)/nav-links.tsx", import.meta.url), "utf8");

  it("requires bookings.manage and uses only the narrow typed read in bridge mode", () => {
    assert.match(page, /requirePermissionAnd\("bookings\.manage"/);
    assert.match(page, /bridgeRpc<\{ timezone: "Asia\/Almaty"; reservations: OperationsReadRow\[\] \}>\("operations\.overview"/);
    assert.match(page, /if \(!legacyBridgeEnabled\(\)\) return null/);
    assert.doesNotMatch(page, /BookingTimeline|getBookingTimeline|calendar\.timeline|withFastApiClient|customerName|customerPhone/);
    assert.match(bridge, /case "operations\.overview":/);
    const operation = bridge.slice(bridge.indexOf("async function operationsOverview"), bridge.indexOf("type CalendarLeadState"));
    assert.doesNotMatch(operation, /customer_name|customer_phone|child_name|comment|source_payload->>['"](?:client|phone|child|age|animator|prepayment|children|adults|comment)['"]/i);
    assert.doesNotMatch(bridge, /case "sql\.|case "query/);
  });

  it("only exposes the navigation link to roles whose existing menu includes bookings.manage", () => {
    assert.match(nav, /items\.some\(\(item\) => item\.href === "\/bookings"\)[\s\S]*?\{ href: "\/operations", label: "Ближайшие праздники" \}/);
    assert.match(nav, /const PRIMARY_HREFS = new Set\(\["\/", "\/bookings", "\/requests", "\/attendance", "\/contacts"\]\)/);
    assert.match(nav, /const MOBILE_PRIMARY_HREFS = new Set\(\["\/", "\/requests", "\/bookings", "\/operations"\]\)/);
    assert.match(nav, /visibleItems\.filter\(\(item\) => PRIMARY_HREFS\.has\(item\.href\)\)/);
    assert.match(nav, /visibleItems\.filter\(\(item\) => !PRIMARY_HREFS\.has\(item\.href\)\)/);
    assert.match(nav, /className="snow-mobile-primary"/);
  });
});
