import type { Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";

export interface SeedPackage {
  id: string;
  name: string;
  /** Regular price in tenge. */
  price: number;
  /** Weekday (Mon-Fri) price in tenge. */
  weekdayPrice: number;
}
export interface SeedRoom {
  id: string;
  name: string;
}

export interface SeedResult {
  packagesAdded: number;
  roomsAdded: number;
  priceRulesAdded: number;
}

/**
 * Loads the reference catalog (ids and names exactly as on the public site, current prices as the first
 * history rows). Idempotent: existing packages/rooms are left alone, and prices are only seeded for a package
 * that has no price history yet, so re-running never overwrites what the Owner set in the admin.
 */
export async function seedCatalog(pool: Pool, data: { packages: SeedPackage[]; rooms: SeedRoom[] }): Promise<SeedResult> {
  return withTx(pool, async (tx) => {
    const result: SeedResult = { packagesAdded: 0, roomsAdded: 0, priceRulesAdded: 0 };
    for (const [i, pkg] of data.packages.entries()) {
      const added = await tx.query("INSERT INTO bb.packages (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [pkg.id, pkg.name, i]);
      result.packagesAdded += added.rowCount ?? 0;
      const has = await tx.query("SELECT 1 FROM bb.price_rules WHERE package_id = $1 LIMIT 1", [pkg.id]);
      if (!has.rowCount) {
        await tx.query("INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt, note) VALUES ($1, 'base', $2, 'seed from public site data')", [pkg.id, pkg.price]);
        await tx.query("INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt, note) VALUES ($1, 'weekday', $2, 'seed from public site data')", [pkg.id, pkg.weekdayPrice]);
        result.priceRulesAdded += 2;
      }
    }
    for (const [i, room] of data.rooms.entries()) {
      const added = await tx.query("INSERT INTO bb.rooms (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [room.id, room.name, i]);
      result.roomsAdded += added.rowCount ?? 0;
    }
    if (result.packagesAdded || result.roomsAdded || result.priceRulesAdded) {
      await writeAudit(tx, { actorUserId: null, action: "catalog.seeded", after: result });
    }
    return result;
  });
}
