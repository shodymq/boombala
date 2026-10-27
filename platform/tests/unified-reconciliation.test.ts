import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileUnifiedBookingSnapshots, type DimensionMappings } from "../src/core/unified-reconciliation.ts";

const mappings: DimensionMappings = {
  branch: { legacy: "fast-branch" },
  package: { "wow-party": "fast-wow" },
  room: { "legacy-room": "fast-room" },
  slot: { "1": "morning" },
  status: { confirmed: "booked" },
};

const legacy = {
  leadId: "legacy-lead-1",
  contactId: "legacy-contact-1",
  phoneE164: "+77070000001",
  requestedDate: "2027-01-20",
  branchId: "legacy",
  packageId: "wow-party",
  roomId: "legacy-room",
  slotId: "1",
  status: "confirmed",
  reservationState: "active" as const,
  depositAmountKzt: 20000,
};

const fast = {
  requestId: "fast-request-1",
  mobileUserId: "mobile-user-1",
  phoneE164: "+77070000001",
  requestedDate: "2027-01-20",
  branchId: "fast-branch",
  packageId: "fast-wow",
  roomId: "fast-room",
  slotId: "morning",
  status: "booked",
  reservationState: "active" as const,
  paymentFactsAmountKzt: 20000,
};

describe("unified booking reconciliation", () => {
  it("matches only an explicit lead and identity link", () => {
    const report = reconcileUnifiedBookingSnapshots({
      legacyLeads: [legacy],
      fastApiLeads: [fast],
      identityLinks: [{ legacyContactId: "legacy-contact-1", mobileUserId: "mobile-user-1", evidence: "verified_external_link" }],
      leadLinks: [{ legacyLeadId: "legacy-lead-1", fastApiRequestId: "fast-request-1", evidence: "verified_external_link" }],
      mappings,
    });
    assert.deepEqual(report.matched, [{ legacyLeadId: "legacy-lead-1", fastApiRequestId: "fast-request-1" }]);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.unlinkedLegacy, []);
    assert.deepEqual(report.unlinkedFastApi, []);
  });

  it("does not join records by phone number", () => {
    const report = reconcileUnifiedBookingSnapshots({
      legacyLeads: [legacy],
      fastApiLeads: [fast],
      identityLinks: [],
      leadLinks: [],
      mappings,
    });
    assert.deepEqual(report.matched, []);
    assert.deepEqual(report.unlinkedLegacy, [{ legacyLeadId: "legacy-lead-1", reason: "missing_lead_link" }]);
    assert.deepEqual(report.phoneCandidates, [{ legacyLeadId: "legacy-lead-1", fastApiRequestIds: ["fast-request-1"] }]);
  });

  it("reports identity, catalog and payment conflicts without changing data", () => {
    const report = reconcileUnifiedBookingSnapshots({
      legacyLeads: [{ ...legacy, depositAmountKzt: 10000 }],
      fastApiLeads: [{ ...fast, mobileUserId: "another-user", roomId: "other-room", paymentFactsAmountKzt: 20000 }],
      identityLinks: [{ legacyContactId: "legacy-contact-1", mobileUserId: "mobile-user-1", evidence: "verified_external_link" }],
      leadLinks: [{ legacyLeadId: "legacy-lead-1", fastApiRequestId: "fast-request-1", evidence: "verified_external_link" }],
      mappings,
    });
    assert.deepEqual(report.conflicts.map((conflict) => conflict.field), ["identity", "roomId", "depositAmountKzt"]);
  });

  it("flags duplicate or incomplete links and leaves unlinked FastAPI records visible", () => {
    const report = reconcileUnifiedBookingSnapshots({
      legacyLeads: [legacy],
      fastApiLeads: [fast, { ...fast, requestId: "fast-request-2" }],
      identityLinks: [],
      leadLinks: [
        { legacyLeadId: "legacy-lead-1", fastApiRequestId: "fast-request-1", evidence: "manual_review" },
        { legacyLeadId: "legacy-lead-1", fastApiRequestId: "fast-request-2", evidence: "manual_review" },
      ],
      mappings,
    });
    assert.deepEqual(report.unlinkedLegacy, [{ legacyLeadId: "legacy-lead-1", reason: "ambiguous_link" }]);
    assert.equal(report.invalidLinks.filter((link) => link.reason === "duplicate").length, 1);
    assert.deepEqual(report.unlinkedFastApi, [
      { fastApiRequestId: "fast-request-1", reason: "missing_lead_link" },
      { fastApiRequestId: "fast-request-2", reason: "missing_lead_link" },
    ]);
    assert.equal(report.invalidLinks.filter((link) => link.reason === "identity_not_verified").length, 2);
  });
});
