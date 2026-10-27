/**
 * Read-only reconciliation primitives for the Platform -> FastAPI cutover.
 *
 * This module deliberately accepts exported snapshots instead of a database
 * connection. It cannot mutate either system and it never treats a phone
 * number as proof that two records belong to the same person.
 */

export type ReconciliationEvidence = "verified_external_link" | "manual_review";
export type ReservationState = "none" | "active" | "released";

export interface LegacyLeadSnapshot {
  leadId: string;
  contactId: string;
  phoneE164?: string | null;
  requestedDate: string;
  branchId?: string | null;
  packageId?: string | null;
  roomId?: string | null;
  slotId?: string | number | null;
  status: string;
  reservationState: ReservationState;
  depositAmountKzt?: number | null;
}

export interface FastApiLeadSnapshot {
  requestId: string;
  mobileUserId: string | null;
  phoneE164?: string | null;
  requestedDate: string;
  branchId?: string | null;
  packageId?: string | null;
  roomId?: string | null;
  slotId?: string | number | null;
  status: string;
  reservationState: ReservationState;
  paymentFactsAmountKzt?: number | null;
}

export interface IdentityLink {
  legacyContactId: string;
  mobileUserId: string;
  evidence: ReconciliationEvidence;
}

export interface LeadLink {
  legacyLeadId: string;
  fastApiRequestId: string;
  evidence: ReconciliationEvidence;
}

export interface DimensionMappings {
  branch: Record<string, string>;
  package: Record<string, string>;
  room: Record<string, string>;
  slot: Record<string, string>;
  status: Record<string, string>;
}

export interface ReconciliationInput {
  legacyLeads: readonly LegacyLeadSnapshot[];
  fastApiLeads: readonly FastApiLeadSnapshot[];
  identityLinks: readonly IdentityLink[];
  leadLinks: readonly LeadLink[];
  mappings: DimensionMappings;
}

export type ReconciliationConflictField =
  | "identity"
  | "requestedDate"
  | "branchId"
  | "packageId"
  | "roomId"
  | "slotId"
  | "status"
  | "reservationState"
  | "depositAmountKzt";

export interface ReconciliationConflict {
  legacyLeadId: string;
  fastApiRequestId: string;
  field: ReconciliationConflictField;
  legacyValue: string | number | null;
  fastApiValue: string | number | null;
}

export interface ReconciliationReport {
  matched: Array<{ legacyLeadId: string; fastApiRequestId: string }>;
  unlinkedLegacy: Array<{ legacyLeadId: string; reason: "missing_lead_link" | "ambiguous_link" | "missing_fastapi_record" }>;
  unlinkedFastApi: Array<{ fastApiRequestId: string; reason: "missing_lead_link" }>;
  conflicts: ReconciliationConflict[];
  phoneCandidates: Array<{ legacyLeadId: string; fastApiRequestIds: string[] }>;
  invalidLinks: Array<{ kind: "identity" | "lead"; id: string; reason: "duplicate" | "missing_target" | "identity_not_verified" }>;
}

const value = (input: string | number | null | undefined): string | number | null => input ?? null;
const slotKey = (input: string | number | null | undefined): string | null => input === null || input === undefined ? null : String(input);

function mapped(mapping: Record<string, string>, source: string | null | undefined): string | null {
  if (source === null || source === undefined) return null;
  return mapping[source] ?? null;
}

function addConflict(
  conflicts: ReconciliationConflict[],
  legacyLeadId: string,
  fastApiRequestId: string,
  field: ReconciliationConflictField,
  legacyValue: string | number | null,
  fastApiValue: string | number | null,
): void {
  if (legacyValue !== fastApiValue) conflicts.push({ legacyLeadId, fastApiRequestId, field, legacyValue, fastApiValue });
}

/** Compare two exported datasets using only explicit identity and catalog links. */
export function reconcileUnifiedBookingSnapshots(input: ReconciliationInput): ReconciliationReport {
  const report: ReconciliationReport = {
    matched: [],
    unlinkedLegacy: [],
    unlinkedFastApi: [],
    conflicts: [],
    phoneCandidates: [],
    invalidLinks: [],
  };
  const fastById = new Map(input.fastApiLeads.map((lead) => [lead.requestId, lead]));
  const legacyById = new Map(input.legacyLeads.map((lead) => [lead.leadId, lead]));
  const identityByContact = new Map<string, IdentityLink[]>();
  for (const link of input.identityLinks) {
    const links = identityByContact.get(link.legacyContactId) ?? [];
    links.push(link);
    identityByContact.set(link.legacyContactId, links);
    if (link.evidence !== "verified_external_link") {
      report.invalidLinks.push({ kind: "identity", id: link.legacyContactId, reason: "identity_not_verified" });
    }
  }

  const leadLinksByLegacy = new Map<string, LeadLink[]>();
  const linkedFastIds = new Set<string>();
  for (const link of input.leadLinks) {
    const links = leadLinksByLegacy.get(link.legacyLeadId) ?? [];
    links.push(link);
    leadLinksByLegacy.set(link.legacyLeadId, links);
    if (links.length > 1) report.invalidLinks.push({ kind: "lead", id: link.legacyLeadId, reason: "duplicate" });
    if (link.evidence !== "verified_external_link") {
      report.invalidLinks.push({ kind: "lead", id: link.legacyLeadId, reason: "identity_not_verified" });
    }
    if (!legacyById.has(link.legacyLeadId) || !fastById.has(link.fastApiRequestId)) {
      report.invalidLinks.push({ kind: "lead", id: link.legacyLeadId, reason: "missing_target" });
    }
  }

  const fastByPhone = new Map<string, string[]>();
  for (const lead of input.fastApiLeads) {
    if (!lead.phoneE164) continue;
    const ids = fastByPhone.get(lead.phoneE164) ?? [];
    ids.push(lead.requestId);
    fastByPhone.set(lead.phoneE164, ids);
  }

  for (const legacy of input.legacyLeads) {
    const rawLinks = leadLinksByLegacy.get(legacy.leadId) ?? [];
    const links = rawLinks.filter((link) => link.evidence === "verified_external_link");
    if (links.length !== 1) {
      report.unlinkedLegacy.push({
        legacyLeadId: legacy.leadId,
        reason: rawLinks.length > 1 ? "ambiguous_link" : "missing_lead_link",
      });
      if (legacy.phoneE164) {
        const candidates = fastByPhone.get(legacy.phoneE164) ?? [];
        if (candidates.length) report.phoneCandidates.push({ legacyLeadId: legacy.leadId, fastApiRequestIds: candidates });
      }
      continue;
    }

    const fast = fastById.get(links[0].fastApiRequestId);
    if (!fast) {
      report.unlinkedLegacy.push({ legacyLeadId: legacy.leadId, reason: "missing_fastapi_record" });
      continue;
    }
    linkedFastIds.add(fast.requestId);
    const identityLinks = identityByContact.get(legacy.contactId) ?? [];
    if (identityLinks.length !== 1 || identityLinks[0].evidence !== "verified_external_link" || identityLinks[0].mobileUserId !== fast.mobileUserId) {
      addConflict(report.conflicts, legacy.leadId, fast.requestId, "identity", identityLinks[0]?.mobileUserId ?? null, fast.mobileUserId);
    }

    addConflict(report.conflicts, legacy.leadId, fast.requestId, "requestedDate", legacy.requestedDate, fast.requestedDate);
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "branchId", mapped(input.mappings.branch, legacy.branchId), value(fast.branchId));
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "packageId", mapped(input.mappings.package, legacy.packageId), value(fast.packageId));
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "roomId", mapped(input.mappings.room, legacy.roomId), value(fast.roomId));
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "slotId", mapped(input.mappings.slot, slotKey(legacy.slotId)), slotKey(fast.slotId));
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "status", mapped(input.mappings.status, legacy.status), value(fast.status));
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "reservationState", legacy.reservationState, fast.reservationState);
    addConflict(report.conflicts, legacy.leadId, fast.requestId, "depositAmountKzt", value(legacy.depositAmountKzt), value(fast.paymentFactsAmountKzt));
    report.matched.push({ legacyLeadId: legacy.leadId, fastApiRequestId: fast.requestId });
  }

  for (const fast of input.fastApiLeads) {
    if (!linkedFastIds.has(fast.requestId)) report.unlinkedFastApi.push({ fastApiRequestId: fast.requestId, reason: "missing_lead_link" });
  }
  return report;
}
