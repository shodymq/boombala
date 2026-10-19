import { z } from "zod";
import type { Client, Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { dummyVerify, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
import { assertCan, isRole, ROLES, type Actor, type Role } from "./rbac.ts";
import { revokeUserSessions } from "./session.ts";

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Минимум ${MIN_PASSWORD_LENGTH} символов`)
  .max(MAX_PASSWORD_LENGTH, `Не больше ${MAX_PASSWORD_LENGTH} символов`);

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email("Некорректный e-mail").max(254),
  name: z.string().trim().min(1, "Укажите имя").max(120),
  role: z.enum(ROLES),
  password: passwordSchema,
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}

const COLUMNS = "id, email, name, role::text AS role, is_active, created_at, last_login_at";
function mapUser(r: { id: string; email: string; name: string; role: string; is_active: boolean; created_at: Date; last_login_at: Date | null }): StaffUser {
  if (!isRole(r.role)) throw new Error("unknown role in database");
  return { id: r.id, email: r.email, name: r.name, role: r.role, isActive: r.is_active, createdAt: r.created_at, lastLoginAt: r.last_login_at };
}

/**
 * Creates a staff user. `actor === null` is only for the bootstrap CLI (first Owner); everything else needs `users.manage`.
 */
export async function createUser(
  pool: Pool,
  actor: Actor | null,
  input: { email: string; name: string; role: Role; password: string },
  meta: RequestMeta = {},
): Promise<StaffUser> {
  if (actor) assertCan(actor, "users.manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(fieldErrors(parsed.error));
  const { email, name, role, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  return withTx(pool, async (tx) => {
    const exists = await tx.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (exists.rowCount) throw new ConflictError("email_taken");
    const { rows } = await tx.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [email, name, role, passwordHash],
    );
    const user = mapUser(rows[0]);
    await writeAudit(tx, { actorUserId: actor?.id ?? null, action: "user.created", entityType: "user", entityId: user.id, after: { email, name, role }, ...meta });
    return user;
  });
}

export async function listUsers(pool: Pool, actor: Actor): Promise<StaffUser[]> {
  assertCan(actor, "users.manage");
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM users ORDER BY created_at`);
  return rows.map(mapUser);
}

/** Locks the active Owners and refuses a change that would leave none. */
async function ensureAnotherOwner(tx: Client, exceptUserId: string): Promise<void> {
  const { rows } = await tx.query("SELECT id FROM users WHERE role = 'owner' AND is_active AND id <> $1 FOR UPDATE", [exceptUserId]);
  if (rows.length === 0) throw new ConflictError("last_owner");
}

export async function changeRole(pool: Pool, actor: Actor, userId: string, role: Role, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "users.manage");
  if (!isRole(role)) throw new ValidationError({ role: "Неизвестная роль" });
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ role: string }>("SELECT role::text AS role FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows[0]) throw new ValidationError({ user: "Пользователь не найден" });
    if (rows[0].role === role) return;
    if (rows[0].role === "owner") await ensureAnotherOwner(tx, userId);
    await tx.query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", [userId, role]);
    await revokeUserSessions(tx, userId); // permissions changed: sign the person in again
    await writeAudit(tx, { actorUserId: actor.id, action: "user.role_changed", entityType: "user", entityId: userId, before: { role: rows[0].role }, after: { role }, ...meta });
  });
}

export async function setActive(pool: Pool, actor: Actor, userId: string, active: boolean, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "users.manage");
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ role: string; is_active: boolean }>("SELECT role::text AS role, is_active FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows[0]) throw new ValidationError({ user: "Пользователь не найден" });
    if (rows[0].is_active === active) return;
    if (!active && rows[0].role === "owner") await ensureAnotherOwner(tx, userId);
    await tx.query("UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1", [userId, active]);
    if (!active) await revokeUserSessions(tx, userId);
    await writeAudit(tx, { actorUserId: actor.id, action: active ? "user.activated" : "user.deactivated", entityType: "user", entityId: userId, ...meta });
  });
}

/** Sets a new password and signs the user out everywhere, except `keepSessionId` (the current device on a self-service change). */
export async function setPassword(
  pool: Pool,
  actor: Actor,
  userId: string,
  password: string,
  opts: { keepSessionId?: string } & RequestMeta = {},
): Promise<void> {
  if (actor.id !== userId) assertCan(actor, "users.manage");
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new ValidationError({ password: parsed.error.issues[0].message });
  const passwordHash = await hashPassword(parsed.data);
  await withTx(pool, async (tx) => {
    const res = await tx.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, passwordHash]);
    if (!res.rowCount) throw new ValidationError({ user: "Пользователь не найден" });
    await revokeUserSessions(tx, userId, opts.keepSessionId);
    await writeAudit(tx, { actorUserId: actor.id, action: "user.password_changed", entityType: "user", entityId: userId, ip: opts.ip, userAgent: opts.userAgent });
  });
}

/** Self-service change: the current password must be proven first. Other devices are signed out, this one stays. */
export async function changeOwnPassword(
  pool: Pool,
  actor: Actor,
  currentPassword: string,
  newPassword: string,
  opts: { keepSessionId?: string } & RequestMeta = {},
): Promise<void> {
  const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1 AND is_active", [actor.id]);
  const ok = rows[0] ? await verifyPassword(rows[0].password_hash, currentPassword) : (await dummyVerify(currentPassword), false);
  if (!ok) throw new ValidationError({ currentPassword: "Неверный текущий пароль" });
  await setPassword(pool, actor, actor.id, newPassword, opts);
}
