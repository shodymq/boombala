import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";

/**
 * Release steps for the birthday catalogue (Pricing V3). Only the sale flag (`packages.is_active`) changes; no package, price rule,
 * booking, reservation or lead is ever deleted or edited here, so the history and the amounts of existing orders stay as they are.
 */

/** The packages of the Pricing V3 catalogue (new sales). */
export const CURRENT_PACKAGES = ["happy-party", "star-party", "boom-bala-party"] as const;
/** The packages that were on sale before V3 (and WOW, already off sale). New bookings must not use them. */
export const LEGACY_PACKAGES = ["wow-party", "magic-party", "boom-party"] as const;

export interface CatalogSnapshot {
  takenAt: string;
  packages: { id: string; isActive: boolean }[];
  priceRules: number;
  reservations: number;
}

/** What the catalogue looks like right now: the state to return to if the release is rolled back. */
export async function snapshotCatalog(db: Queryable, now = new Date()): Promise<CatalogSnapshot> {
  const packages = (await db.query<{ id: string; is_active: boolean }>("SELECT id, is_active FROM bb.packages ORDER BY id")).rows;
  const priceRules = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM bb.price_rules")).rows[0].n);
  const reservations = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM bb.slot_reservations")).rows[0].n);
  return { takenAt: now.toISOString(), packages: packages.map((p) => ({ id: p.id, isActive: p.is_active })), priceRules, reservations };
}

/** Takes the legacy packages off sale. Idempotent. Returns the ids that were switched off in this call. */
export async function retireLegacyPackages(pool: Pool): Promise<string[]> {
  return withTx(pool, async (tx) => {
    // Only switch the legacy ones off after the V3 packages are active and priced; otherwise the site would have nothing to sell.
    const ready = await tx.query<{ id: string }>(
      `SELECT p.id FROM bb.packages p WHERE p.id = ANY($1::text[]) AND p.is_active
         AND EXISTS (SELECT 1 FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'base')
         AND EXISTS (SELECT 1 FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'weekday')`,
      [[...CURRENT_PACKAGES]],
    );
    if (ready.rows.length !== CURRENT_PACKAGES.length) throw new Error("current_packages_not_ready: run db:seed first");
    const off = await tx.query<{ id: string }>("UPDATE bb.packages SET is_active = false WHERE id = ANY($1::text[]) AND is_active RETURNING id", [[...LEGACY_PACKAGES]]);
    const ids = off.rows.map((r) => r.id).sort();
    if (ids.length > 0) await writeAudit(tx, { actorUserId: null, action: "catalog.legacy_retired", entityType: "package", entityId: ids.join(","), after: { packages: ids } });
    return ids;
  });
}

/**
 * Restores the sale flags from a snapshot taken before the release. Packages that are not in the snapshot are left alone. With
 * `deactivateCurrent` the Pricing V3 packages are taken off NEW sales (their bookings and prices stay).
 */
export async function restoreCatalog(pool: Pool, snapshot: CatalogSnapshot, options: { deactivateCurrent: boolean }): Promise<{ restored: string[]; deactivated: string[] }> {
  return withTx(pool, async (tx) => {
    const restored: string[] = [];
    for (const p of snapshot.packages) {
      const r = await tx.query<{ id: string }>("UPDATE bb.packages SET is_active = $2 WHERE id = $1 AND is_active IS DISTINCT FROM $2 RETURNING id", [p.id, p.isActive]);
      if (r.rows.length) restored.push(p.id);
    }
    const deactivated: string[] = [];
    if (options.deactivateCurrent) {
      const r = await tx.query<{ id: string }>("UPDATE bb.packages SET is_active = false WHERE id = ANY($1::text[]) AND is_active RETURNING id", [[...CURRENT_PACKAGES]]);
      deactivated.push(...r.rows.map((x) => x.id).sort());
    }
    await writeAudit(tx, { actorUserId: null, action: "catalog.restored", entityType: "package", entityId: "catalog", after: { restored, deactivated, snapshotTakenAt: snapshot.takenAt } });
    return { restored, deactivated };
  });
}
