import type { Queryable } from "./db.ts";

export interface AuditEntry {
  actorUserId: string | null;
  /** `domain.verb`, e.g. `auth.login`, `user.role_changed`, `price.set`. */
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** Append-only (a trigger forbids UPDATE/DELETE). Pass the transaction client so the entry commits with the change. */
export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorUserId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
      entry.userAgent ? entry.userAgent.slice(0, 400) : null,
    ],
  );
}
