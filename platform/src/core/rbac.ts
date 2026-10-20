import { ForbiddenError } from "./errors.ts";

export const ROLES = ["owner", "manager", "editor"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard.view",
  "catalog.view",
  "prices.manage",
  "users.manage",
  "audit.view",
  "requests.manage",
  "bookings.manage",
  "contacts.view",
  "contacts.export",
  "legal.manage",
  "news.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role matrix (MVP). Enforced on the server in every query/mutation; hidden buttons are only a convenience.
 *  owner   : everything
 *  manager : requests, bookings, clients (as far as needed to work with them)
 *  editor  : news only
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  // `contacts.export` is NOT part of the manager role: it is granted per person (users.can_export), see canExport().
  manager: ["dashboard.view", "catalog.view", "requests.manage", "bookings.manage", "contacts.view"],
  editor: ["dashboard.view", "news.manage"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export interface Actor {
  id: string;
  role: Role;
  /** Personal permission to export contact data (Owner always may). */
  canExport?: boolean;
}

/** Export of personal data: the Owner, or a Manager the Owner explicitly allowed. Never an Editor. */
export function canExport(actor: { role: Role; canExport?: boolean }): boolean {
  return actor.role === "owner" || (actor.role === "manager" && actor.canExport === true);
}

export function assertCanExport(actor: Actor): void {
  if (!canExport(actor)) throw new ForbiddenError("export not allowed");
}

/** Throws unless the actor holds the permission. Call it at the top of every data-access function. */
export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) throw new ForbiddenError(`${actor.role} lacks ${permission}`);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
