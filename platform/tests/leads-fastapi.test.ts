import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AdminLeadContractError,
  errorCodeOf,
  FASTAPI_LEAD_STATUSES,
  PROPOSED_CRM_STATUS,
  parseAdminLeadDetailStatus,
  parseAdminLeadList,
} from "../src/core/leads-fastapi.ts";

/** Real responses captured from BoomBalaApp origin/main (admin lead inbox tests, same seed). */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): { status: number; body: unknown } =>
  JSON.parse(readFileSync(join(here, "fixtures", "admin-leads", `${name}.json`), "utf8"));

describe("FastAPI admin lead inbox: contract against real responses", () => {
  it("the list parses into rows that keep the FastAPI status and the proposed CRM status", () => {
    const list = parseAdminLeadList(fixture("leads_list").body);
    assert.equal(list.total, list.items.length);
    const inProgress = list.items.find((i) => i.id === "lead-in-progress");
    assert.ok(inProgress);
    assert.equal(inProgress.status, "in_progress");
    assert.equal(inProgress.crmStatus, "in_progress");
    assert.equal(inProgress.branchId, "branch-main");
    // the real answer carries no package for this lead: the row keeps it as null, it does not invent one
    assert.equal(inProgress.packageName, null);
    const withPackage = list.items.find((i) => i.id === "lead-new");
    assert.equal(withPackage?.packageName, "Spark Party");
  });

  it("the parsed row carries only the fields the CRM reads (no notes, no email, no extra keys)", () => {
    const list = parseAdminLeadList(fixture("leads_list").body);
    const keys = Object.keys(list.items[0]).sort();
    assert.deepEqual(keys, [
      "branchId",
      "branchName",
      "createdAt",
      "crmStatus",
      "customerName",
      "firstContactMinutes",
      "guestCount",
      "id",
      "packageId",
      "packageName",
      "phone",
      "requestedDate",
      "source",
      "status",
      "summary",
      "type",
      "waitingForContactMinutes",
    ]);
  });

  it("a status FastAPI does not know is an error, never a guessed row", () => {
    const body = structuredClone(fixture("leads_list").body) as { items: Array<Record<string, unknown>> };
    body.items[0].status = "future_status_from_codex";
    assert.throws(() => parseAdminLeadList(body), (e: unknown) => e instanceof AdminLeadContractError && e.field === "status");
  });

  it("a list without items or total is an error, not an empty inbox", () => {
    assert.throws(() => parseAdminLeadList({ total: 0 }), (e: unknown) => e instanceof AdminLeadContractError && e.field === "items");
    assert.throws(() => parseAdminLeadList({ items: [] }), (e: unknown) => e instanceof AdminLeadContractError && e.field === "total");
    assert.throws(() => parseAdminLeadList(null), AdminLeadContractError);
  });

  it("malformed dates and counts are refused", () => {
    const base = fixture("leads_list").body as { items: Array<Record<string, unknown>>; total: number };
    const badDate = structuredClone(base);
    badDate.items[0].requestedDate = "20.04.2026";
    assert.throws(() => parseAdminLeadList(badDate), (e: unknown) => e instanceof AdminLeadContractError && e.field === "requestedDate");
    const badCount = structuredClone(base);
    badCount.items[0].guestCount = -3;
    assert.throws(() => parseAdminLeadList(badCount), (e: unknown) => e instanceof AdminLeadContractError && e.field === "guestCount");
  });

  it("the status change answer is the lead detail after the change", () => {
    const out = parseAdminLeadDetailStatus(fixture("lead_status_update").body);
    assert.equal(out.id, "lead-new");
    assert.equal(out.status, "contacted");
  });

  it("error envelopes match the real codes: 401 authentication_required, 422 validation_error, 404 lead_not_found", () => {
    assert.equal(errorCodeOf(fixture("leads_no_token").body), "authentication_required");
    assert.equal(fixture("leads_no_token").status, 401);
    assert.equal(errorCodeOf(fixture("lead_status_invalid").body), "validation_error");
    assert.equal(fixture("lead_status_invalid").status, 422);
    assert.equal(errorCodeOf(fixture("lead_detail_unknown").body), "lead_not_found");
    assert.equal(fixture("lead_detail_unknown").status, 404);
  });
});

describe("status vocabulary: the proposed mapping is complete and explicit", () => {
  it("every FastAPI status has a CRM mapping entry (a value or an explicit null)", () => {
    for (const status of FASTAPI_LEAD_STATUSES) {
      assert.ok(Object.prototype.hasOwnProperty.call(PROPOSED_CRM_STATUS, status), `no entry for ${status}`);
    }
    assert.equal(Object.keys(PROPOSED_CRM_STATUS).length, FASTAPI_LEAD_STATUSES.length);
  });

  it("CRM values are only the five the staff CRM stores today", () => {
    const allowed = new Set(["new", "in_progress", "confirmed", "cancelled", "completed", null]);
    for (const value of Object.values(PROPOSED_CRM_STATUS)) assert.ok(allowed.has(value), String(value));
  });
});
