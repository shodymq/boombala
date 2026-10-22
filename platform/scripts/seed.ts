// Loads packages, rooms and their current prices from the PUBLIC SITE's own data files, so ids, names and prices
// are never retyped. Safe to re-run (see seedCatalog).
import { createPool } from "../src/core/db.ts";
import { seedCatalog } from "../src/core/seed.ts";
import { birthdayPackages } from "../../src/data/birthdays.ts";
import { birthdayRooms } from "../../src/data/birthdayRooms.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = createPool(url, 2);
try {
  const result = await seedCatalog(pool, {
    packages: birthdayPackages.map((p) => ({ id: p.id, name: p.name, price: p.price, weekdayPrice: p.weekdayPrice })),
    rooms: birthdayRooms.map((r) => ({ id: r.id, name: r.name })),
  });
  console.log("seed:", JSON.stringify(result));
} finally {
  await pool.end();
}
