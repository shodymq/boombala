import type { Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";

export const LEAD_NEXT_ACTIONS = ["call_customer", "clarify_details", "prepare_offer", "await_reply", "schedule_visit"] as const;
export type LeadNextAction = (typeof LEAD_NEXT_ACTIONS)[number];

export const LEAD_NEXT_ACTION_LABELS: Record<LeadNextAction, string> = {
  call_customer: "Позвонить клиенту",
  clarify_details: "Уточнить детали",
  prepare_offer: "Подготовить предложение",
  await_reply: "Ожидать ответа",
  schedule_visit: "Согласовать визит",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const almatyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function localParts(date: Date): number[] {
  const p = Object.fromEntries(almatyFormatter.formatToParts(date).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute)];
}

/** Converts a browser datetime-local value in Asia/Almaty into an instant without using the host timezone. */
export function almatyLocalDateTimeToInstant(value: string): Date {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) throw new ValidationError({ followUpAt: "invalid" });
  const wanted = match.slice(1).map(Number);
  const [year, month, day, hour, minute] = wanted;
  const wallEpoch = Date.UTC(year, month - 1, day, hour, minute);
  const wall = new Date(wallEpoch);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() + 1 !== month || wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute) {
    throw new ValidationError({ followUpAt: "invalid" });
  }

  // Resolve the zone offset from Intl instead of assuming the Node/Vercel process timezone.
  let epoch = wallEpoch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const got = localParts(new Date(epoch));
    const observedWallEpoch = Date.UTC(got[0], got[1] - 1, got[2], got[3], got[4]);
    epoch += wallEpoch - observedWallEpoch;
  }
  const result = new Date(epoch);
  if (localParts(result).some((part, index) => part !== wanted[index])) throw new ValidationError({ followUpAt: "invalid" });
  return result;
}

export function instantToAlmatyLocalDateTime(value: Date | string | null): string {
  if (value === null) return "";
  const parts = localParts(value instanceof Date ? value : new Date(value));
  const [year, month, day, hour, minute] = parts;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface LeadWorkflowUpdateInput {
  leadId: string;
  expectedVersion: number;
  assignedTo: string | null;
  nextAction: LeadNextAction | null;
  followUpAtLocal: string | null;
  /** Optional for older callers; omission preserves the existing agreement. */
  managerAgreement?: string | null;
}

export interface LeadWorkflowClaimInput { leadId: string; expectedVersion: number }

export function parseLeadWorkflowUpdate(value: unknown): LeadWorkflowUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError({ input: "invalid" });
  const input = value as Record<string, unknown>;
  const leadId = typeof input.leadId === "string" ? input.leadId : "";
  const expectedVersion = input.expectedVersion;
  const assignedTo = input.assignedTo;
  const nextAction = input.nextAction;
  const followUpAtLocal = input.followUpAtLocal;
  const managerAgreement = input.managerAgreement;
  if (!UUID.test(leadId) || !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) throw new ValidationError({ input: "invalid" });
  if (assignedTo !== null && (typeof assignedTo !== "string" || !UUID.test(assignedTo))) throw new ValidationError({ assignedTo: "invalid" });
  if (nextAction !== null && !(LEAD_NEXT_ACTIONS as readonly unknown[]).includes(nextAction)) throw new ValidationError({ nextAction: "invalid" });
  if (followUpAtLocal !== null && typeof followUpAtLocal !== "string") throw new ValidationError({ followUpAt: "invalid" });
  const local = followUpAtLocal as string | null;
  if ((nextAction === null) !== (local === null)) throw new ValidationError({ followUpAt: "action_and_time_required_together" });
  if (local !== null) almatyLocalDateTimeToInstant(local);
  let agreement: string | null | undefined;
  if (managerAgreement === undefined || managerAgreement === null) agreement = managerAgreement;
  else if (typeof managerAgreement !== "string" || managerAgreement.length > 1000) throw new ValidationError({ managerAgreement: "invalid" });
  else agreement = managerAgreement.trim() || null;
  return { leadId, expectedVersion: Number(expectedVersion), assignedTo: assignedTo as string | null, nextAction: nextAction as LeadNextAction | null, followUpAtLocal: local, managerAgreement: agreement };
}

export function parseLeadWorkflowClaim(value: unknown): LeadWorkflowClaimInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError({ input: "invalid" });
  const input = value as Record<string, unknown>;
  if (typeof input.leadId !== "string" || !UUID.test(input.leadId) || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    throw new ValidationError({ input: "invalid" });
  }
  return { leadId: input.leadId, expectedVersion: Number(input.expectedVersion) };
}

type WorkflowRow = {
  id: string; status: string; assigned_to: string | null; assigned_name: string | null; next_action: LeadNextAction | null;
  follow_up_at: Date | null; manager_agreement: string | null; workflow_version: number;
};
type AuditMeta = { ip?: string | null; userAgent?: string | null };

async function writeWorkflow(
  pool: Pool,
  actor: Actor,
  input: LeadWorkflowUpdateInput,
  meta: AuditMeta,
  mode: "update" | "claim",
): Promise<{ version: number; assignedTo: string | null; nextAction: LeadNextAction | null; followUpAt: string | null }> {
  assertCan(actor, "requests.manage");
  const followUpAt = input.followUpAtLocal === null ? null : almatyLocalDateTimeToInstant(input.followUpAtLocal);

  return withTx(pool, async (tx) => {
    const selected = await tx.query<WorkflowRow>(
      `SELECT l.id, l.status, l.assigned_to, u.name AS assigned_name, l.next_action, l.follow_up_at, l.manager_agreement, l.workflow_version
         FROM bb.lead_requests l LEFT JOIN bb.users u ON u.id = l.assigned_to WHERE l.id = $1 FOR UPDATE OF l`,
      [input.leadId],
    );
    const before = selected.rows[0];
    if (!before) throw new NotFoundError();
    if (before.workflow_version !== input.expectedVersion) throw new ConflictError("stale_update");
    if (before.status !== "new" && before.status !== "in_progress") throw new ConflictError("lead_not_open");

    const nextAssignedTo = mode === "claim" ? actor.id : input.assignedTo;
    if (mode === "claim" && before.assigned_to && before.assigned_to !== actor.id) throw new ConflictError("lead_already_assigned");
    let nextAssignedName: string | null = null;
    if (nextAssignedTo) {
      const assigned = await tx.query<{ name: string }>(
        "SELECT name FROM bb.users WHERE id = $1 AND is_active AND role::text IN ('owner', 'manager')",
        [nextAssignedTo],
      );
      if (!assigned.rows[0]) throw new ValidationError({ assignedTo: "not_assignable" });
      nextAssignedName = assigned.rows[0].name;
    }
    const nextAction = mode === "claim" ? before.next_action : input.nextAction;
    const nextFollowUpAt = mode === "claim" ? before.follow_up_at : followUpAt;
    const nextAgreement = mode === "claim" || input.managerAgreement === undefined ? before.manager_agreement : input.managerAgreement;
    const sameInstant = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const unchanged = before.assigned_to === nextAssignedTo && before.next_action === nextAction && sameInstant(before.follow_up_at, nextFollowUpAt) && before.manager_agreement === nextAgreement;
    if (unchanged) return { version: before.workflow_version, assignedTo: before.assigned_to, nextAction: before.next_action, followUpAt: before.follow_up_at?.toISOString() ?? null };

    const updated = await tx.query<{ workflow_version: number; assigned_to: string | null; next_action: LeadNextAction | null; follow_up_at: Date | null; manager_agreement: string | null }>(
      `UPDATE bb.lead_requests
          SET assigned_to = $3, next_action = $4, follow_up_at = $5, manager_agreement = $6, workflow_version = workflow_version + 1
        WHERE id = $1 AND workflow_version = $2 AND status IN ('new', 'in_progress')
        RETURNING workflow_version, assigned_to, next_action, follow_up_at, manager_agreement`,
      [input.leadId, input.expectedVersion, nextAssignedTo, nextAction, nextFollowUpAt, nextAgreement],
    );
    if (!updated.rows[0]) throw new ConflictError("stale_update");
    const after = updated.rows[0];
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: mode === "claim" ? "lead.claimed" : "lead.workflow_updated",
      entityType: "lead_request",
      entityId: input.leadId,
      before: { assignedTo: before.assigned_to, assigneeName: before.assigned_name, nextAction: before.next_action, followUpAt: before.follow_up_at?.toISOString() ?? null, version: before.workflow_version },
      after: { assignedTo: after.assigned_to, assigneeName: nextAssignedName, nextAction: after.next_action, followUpAt: after.follow_up_at?.toISOString() ?? null, version: after.workflow_version, agreementChanged: before.manager_agreement !== after.manager_agreement },
      ...meta,
    });
    return { version: after.workflow_version, assignedTo: after.assigned_to, nextAction: after.next_action, followUpAt: after.follow_up_at?.toISOString() ?? null };
  });
}

export async function updateLeadWorkflow(pool: Pool, actor: Actor, rawInput: unknown, meta: AuditMeta = {}) {
  const input = parseLeadWorkflowUpdate(rawInput);
  return writeWorkflow(pool, actor, input, meta, "update");
}

export async function claimLead(pool: Pool, actor: Actor, rawInput: unknown, meta: AuditMeta = {}) {
  const input = parseLeadWorkflowClaim(rawInput);
  return writeWorkflow(pool, actor, { ...input, assignedTo: actor.id, nextAction: null, followUpAtLocal: null }, meta, "claim");
}

export interface LeadAssignee { id: string; name: string; role: "owner" | "manager" }
export interface LeadWorkflowHistory {
  id: number; at: Date; actorName: string | null; action: "lead.claimed" | "lead.workflow_updated";
  before: { assignedTo: string | null; assigneeName: string | null; nextAction: LeadNextAction | null; followUpAt: string | null; agreementChanged?: boolean };
  after: { assignedTo: string | null; assigneeName: string | null; nextAction: LeadNextAction | null; followUpAt: string | null; agreementChanged?: boolean };
}
export interface LeadWorkflowContext { assignees: LeadAssignee[]; history: LeadWorkflowHistory[] }

function auditSnapshot(value: unknown): LeadWorkflowHistory["before"] {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    assignedTo: typeof v.assignedTo === "string" ? v.assignedTo : null,
    assigneeName: typeof v.assigneeName === "string" ? v.assigneeName : null,
    nextAction: typeof v.nextAction === "string" && (LEAD_NEXT_ACTIONS as readonly string[]).includes(v.nextAction) ? v.nextAction as LeadNextAction : null,
    followUpAt: typeof v.followUpAt === "string" ? v.followUpAt : null,
    ...(v.agreementChanged === true ? { agreementChanged: true } : {}),
  };
}

export async function getLeadWorkflowContext(pool: Pool, actor: Actor, leadId: string): Promise<LeadWorkflowContext> {
  assertCan(actor, "requests.manage");
  if (!UUID.test(leadId)) throw new NotFoundError();
  const exists = await pool.query("SELECT 1 FROM bb.lead_requests WHERE id = $1", [leadId]);
  if (!exists.rowCount) throw new NotFoundError();
  const [assignees, events] = await Promise.all([
    pool.query<{ id: string; name: string; role: "owner" | "manager" }>(
      "SELECT id, name, role::text AS role FROM bb.users WHERE is_active AND role::text IN ('owner', 'manager') ORDER BY CASE role::text WHEN 'owner' THEN 0 ELSE 1 END, name, id",
    ),
    pool.query<{ id: string; at: Date; actor_name: string | null; action: LeadWorkflowHistory["action"]; before: unknown; after: unknown }>(
      `SELECT a.id, a.at, u.name AS actor_name, a.action, a.before, a.after
         FROM bb.audit_log a LEFT JOIN bb.users u ON u.id = a.actor_user_id
        WHERE a.entity_type = 'lead_request' AND a.entity_id = $1 AND a.action IN ('lead.claimed', 'lead.workflow_updated')
        ORDER BY a.id DESC LIMIT 50`,
      [leadId],
    ),
  ]);
  return {
    assignees: assignees.rows,
    history: events.rows.map((row) => ({ id: Number(row.id), at: row.at, actorName: row.actor_name, action: row.action, before: auditSnapshot(row.before), after: auditSnapshot(row.after) })),
  };
}
