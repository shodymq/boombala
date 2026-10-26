/** Every status a lead request can have (lead_requests.status, migration 004_crm). */
export const LEAD_STATUSES = ["new", "in_progress", "confirmed", "cancelled", "completed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * What a manager may set by hand. "confirmed" comes only from confirmLead (it books a slot); cancelling a confirmed lead
 * goes through releaseReservation. Both are outside this matrix on purpose.
 */
export const MANAGER_TARGETS = ["new", "in_progress", "cancelled"] as const;
export type ManagerTarget = (typeof MANAGER_TARGETS)[number];

/**
 * Explicit transition matrix for the manager path: from -> the targets allowed from it. Anything not listed is refused.
 * `cancelled` is terminal (re-opening a cancelled request is not allowed); `confirmed` and `completed` have no manager
 * transition here. A request to set the status it already has is a no-op, handled by the caller, not by this matrix.
 */
const MANAGER_MATRIX: Record<LeadStatus, readonly ManagerTarget[]> = {
  new: ["in_progress", "cancelled"],
  in_progress: ["new", "cancelled"],
  confirmed: [],
  cancelled: [],
  completed: [],
};

export function canManagerTransition(from: LeadStatus, to: ManagerTarget): boolean {
  return MANAGER_MATRIX[from].includes(to);
}
