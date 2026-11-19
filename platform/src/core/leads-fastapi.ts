/**
 * Contract of the FastAPI admin lead inbox (BoomBalaApp `GET /api/v1/admin/leads`, `GET /admin/leads/{id}`,
 * `PATCH /admin/leads/{id}/status`), read from real responses (tests/fixtures/admin-leads/*.json).
 *
 * Pure: no database, no network, no runtime wiring. The staff CRM keeps its own data until the cutover is approved
 * (see docs/platform/ADMIN-LEADS-SLICE.md). Anything this module cannot read exactly is an error, never a guessed row.
 */

/** Statuses FastAPI returns today (backend app/modules/leads/constants.py). */
export const FASTAPI_LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "booked",
  "paid",
  "completed",
  "lost",
  "in_progress",
  "confirmed",
  "cancelled",
  "closed",
] as const;
export type FastapiLeadStatus = (typeof FASTAPI_LEAD_STATUSES)[number];

/**
 * PROPOSED mapping to the statuses the staff CRM stores today (`bb.lead_requests`: new | in_progress | confirmed |
 * cancelled | completed). Several FastAPI states collapse into one CRM state; this table is a proposal for the owner and
 * Codex to confirm, not a decision. A status without an entry maps to null: the CRM must show it as unknown.
 */
export const PROPOSED_CRM_STATUS: Readonly<Record<FastapiLeadStatus, "new" | "in_progress" | "confirmed" | "cancelled" | "completed" | null>> = {
  new: "new",
  contacted: "in_progress",
  qualified: "in_progress",
  in_progress: "in_progress",
  booked: "confirmed",
  confirmed: "confirmed",
  paid: "confirmed",
  completed: "completed",
  lost: "cancelled",
  cancelled: "cancelled",
  closed: "completed",
};

export class AdminLeadContractError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`admin_lead_contract:${field}`);
    this.name = "AdminLeadContractError";
    this.field = field;
  }
}

export interface AdminLeadRow {
  id: string;
  type: string;
  summary: string;
  /** The FastAPI status, exactly as returned. */
  status: FastapiLeadStatus;
  /** The CRM status under the proposed mapping, or null when no mapping exists. */
  crmStatus: (typeof PROPOSED_CRM_STATUS)[FastapiLeadStatus];
  source: string;
  customerName: string;
  phone: string;
  guestCount: number | null;
  requestedDate: string | null;
  createdAt: string;
  waitingForContactMinutes: number | null;
  firstContactMinutes: number | null;
  branchId: string | null;
  branchName: string | null;
  packageId: string | null;
  packageName: string | null;
}

export interface AdminLeadList {
  items: AdminLeadRow[];
  total: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new AdminLeadContractError(field);
  return v;
};
const optStr = (v: unknown, field: string): string | null => {
  if (v === null || v === undefined) return null;
  return str(v, field);
};
const optInt = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || (v as number) < 0) throw new AdminLeadContractError(field);
  return v as number;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function isFastapiLeadStatus(v: unknown): v is FastapiLeadStatus {
  return typeof v === "string" && (FASTAPI_LEAD_STATUSES as readonly string[]).includes(v);
}

/** One item. Every field the CRM uses is checked; unknown extra fields are ignored and never copied. */
export function parseAdminLeadItem(v: unknown): AdminLeadRow {
  if (!isRecord(v)) throw new AdminLeadContractError("item");
  if (!isFastapiLeadStatus(v.status)) throw new AdminLeadContractError("status");
  const requestedDate = optStr(v.requestedDate, "requestedDate");
  if (requestedDate !== null && !DATE_RE.test(requestedDate)) throw new AdminLeadContractError("requestedDate");
  const createdAt = str(v.createdAt, "createdAt");
  if (!TIME_RE.test(createdAt)) throw new AdminLeadContractError("createdAt");
  const branch = v.branch === null || v.branch === undefined ? null : isRecord(v.branch) ? v.branch : (() => { throw new AdminLeadContractError("branch"); })();
  const pkg = v.package === null || v.package === undefined ? null : isRecord(v.package) ? v.package : (() => { throw new AdminLeadContractError("package"); })();
  return {
    id: str(v.id, "id"),
    type: str(v.type, "type"),
    summary: str(v.summary, "summary"),
    status: v.status,
    crmStatus: PROPOSED_CRM_STATUS[v.status],
    source: str(v.source, "source"),
    customerName: str(v.customerName, "customerName"),
    phone: str(v.phone, "phone"),
    guestCount: optInt(v.guestCount, "guestCount"),
    requestedDate,
    createdAt,
    waitingForContactMinutes: optInt(v.waitingForContactMinutes, "waitingForContactMinutes"),
    firstContactMinutes: optInt(v.firstContactMinutes, "firstContactMinutes"),
    branchId: branch ? str(branch.id, "branch.id") : null,
    branchName: branch ? str(branch.name, "branch.name") : null,
    packageId: pkg ? str(pkg.id, "package.id") : null,
    packageName: pkg ? str(pkg.name, "package.name") : null,
  };
}

/** The list answer. A missing `items` or `total` is an error, never an empty inbox. */
export function parseAdminLeadList(v: unknown): AdminLeadList {
  if (!isRecord(v) || !Array.isArray(v.items)) throw new AdminLeadContractError("items");
  const total = optInt(v.total, "total");
  if (total === null) throw new AdminLeadContractError("total");
  const items = v.items.map(parseAdminLeadItem);
  return { items, total };
}

/** Status PATCH answer: the detail of the lead after the change. */
export function parseAdminLeadDetailStatus(v: unknown): { id: string; status: FastapiLeadStatus } {
  if (!isRecord(v)) throw new AdminLeadContractError("detail");
  if (!isFastapiLeadStatus(v.status)) throw new AdminLeadContractError("status");
  return { id: str(v.id, "id"), status: v.status };
}

/** The error envelope FastAPI uses for non-2xx answers (checked on the captured 401 and 422). */
export function errorCodeOf(v: unknown): string | null {
  if (!isRecord(v)) return null;
  if (isRecord(v.error) && typeof v.error.code === "string") return v.error.code;
  return null;
}
