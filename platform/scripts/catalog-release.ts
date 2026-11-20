import { readFile, writeFile } from "node:fs/promises";
import { createPool } from "../src/core/db.ts";
import { retireLegacyPackages, restoreCatalog, snapshotCatalog, type CatalogSnapshot } from "../src/core/catalog-release.ts";

// Birthday catalogue release steps. Prints ids and counts only (never a connection string).
//   node scripts/catalog-release.ts snapshot <file>             record the sale flags BEFORE the release (rollback target)
//   node scripts/catalog-release.ts retire-legacy               after the site switch: WOW / MAGIC / old BOOM off sale
//   node scripts/catalog-release.ts restore <file> [--deactivate-current]   rollback: the sale flags exactly as in the snapshot
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(2);
}
const [command, file, ...flags] = process.argv.slice(2);
const pool = createPool(url, { max: 1 });
try {
  if (command === "snapshot") {
    if (!file) throw new Error("usage: snapshot <file>");
    const snap = await snapshotCatalog(pool);
    await writeFile(file, JSON.stringify(snap, null, 2) + "\n");
    console.log(`snapshot: ${snap.packages.length} packages (${snap.packages.filter((p) => p.isActive).map((p) => p.id).join(", ") || "none active"}), ${snap.priceRules} price rules, ${snap.reservations} reservations -> ${file}`);
  } else if (command === "retire-legacy") {
    const off = await retireLegacyPackages(pool);
    console.log(off.length ? `retired from sale: ${off.join(", ")}` : "nothing to retire (already off sale)");
  } else if (command === "restore") {
    if (!file) throw new Error("usage: restore <file> [--deactivate-current]");
    const snap = JSON.parse(await readFile(file, "utf8")) as CatalogSnapshot;
    const r = await restoreCatalog(pool, snap, { deactivateCurrent: flags.includes("--deactivate-current") });
    console.log(`restored: ${r.restored.join(", ") || "none"}; deactivated for new sales: ${r.deactivated.join(", ") || "none"}`);
  } else {
    console.error("commands: snapshot <file> | retire-legacy | restore <file> [--deactivate-current]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`catalog-release: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
