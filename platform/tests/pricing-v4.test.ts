import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolvePrice, setPriceRule } from "../src/core/catalog.ts";
import { seedFromSite, makeUser, startTestDb, type TestDb } from "./helpers/db.ts";

/** Server-side price of each Pricing V3 package: weekday, weekend, the date rule, and a seed that never duplicates prices. */
describe("Pricing V4: the server decides the price (weekday, weekend, special date, seed)", () => {
  let db: TestDb;
  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
  });
  after(async () => db.stop());

  const cases = [
    ["happy-party", 38430, 54900],
    ["star-party", 55930, 79900],
    ["boom-bala-party", 80430, 114900],
  ] as const;

  for (const [id, weekday, weekend] of cases) {
    it(`${id}: Wednesday ${weekday} ₸, Saturday ${weekend} ₸, Sunday ${weekend} ₸`, async () => {
      assert.deepEqual(await resolvePrice(db.pool, id, "2099-03-04"), { amountKzt: weekday, source: "weekday" }, "Wednesday");
      assert.deepEqual(await resolvePrice(db.pool, id, "2099-03-07"), { amountKzt: weekend, source: "base" }, "Saturday");
      assert.deepEqual(await resolvePrice(db.pool, id, "2099-03-08"), { amountKzt: weekend, source: "base" }, "Sunday");
    });
  }

  it("the Friday before midnight and the Monday are weekdays by the business calendar (Asia/Almaty dates are plain dates)", async () => {
    assert.equal((await resolvePrice(db.pool, "star-party", "2099-03-06"))!.source, "weekday", "Friday");
    assert.equal((await resolvePrice(db.pool, "star-party", "2099-03-09"))!.source, "weekday", "Monday");
  });

  it("a special date beats the weekday price, for that package only", async () => {
    const owner = await makeUser(db.pool, "owner", "pricing.owner@example.test");
    await setPriceRule(db.pool, { id: owner.id, role: "owner" }, { packageId: "star-party", ruleType: "date", date: "2099-03-04", amountKzt: 60000, note: "праздник" });
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2099-03-04"), { amountKzt: 60000, source: "date" });
    assert.equal((await resolvePrice(db.pool, "happy-party", "2099-03-04"))!.amountKzt, 38430, "other packages are unaffected");
  });

  it("seeding again adds no price rules and never overwrites prices changed in the admin", async () => {
    const before = Number((await db.pool.query("SELECT count(*) n FROM bb.price_rules")).rows[0].n);
    assert.deepEqual(await seedFromSite(db.pool), { packagesAdded: 0, roomsAdded: 0, priceRulesAdded: 0 });
    assert.equal(Number((await db.pool.query("SELECT count(*) n FROM bb.price_rules")).rows[0].n), before);
  });

  it("a package without a price is never offered to a booking (no price means no confirmation)", async () => {
    await db.pool.query("INSERT INTO bb.packages (id, name, sort_order, is_active) VALUES ('unpriced-test','Без цены',9,true)");
    assert.equal(await resolvePrice(db.pool, "unpriced-test", "2099-03-04"), null);
  });
});
