import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { catalogSummary, isWeekday, listPackages, listRooms, listSlots, priceHistory, resolvePrice, setPriceRule } from "../src/core/catalog.ts";
import { ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { seedFromSite, makeUser, startTestDb, type TestDb } from "./helpers/db.ts";
import { birthdayPackages } from "../../src/data/birthdays.ts";
import { birthdayRooms } from "../../src/data/birthdayRooms.ts";

describe("catalog seeded from the public site and price hierarchy", () => {
  let db: TestDb;
  let owner: { id: string; role: "owner" };
  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    const u = await makeUser(db.pool, "owner");
    owner = { id: u.id, role: "owner" };
  });
  after(async () => {
    await db.stop();
  });

  it("packages, rooms and prices equal the data of the public site", async () => {
    const packages = await listPackages(db.pool);
    assert.deepEqual(packages.map((p) => [p.id, p.name]), birthdayPackages.map((p) => [p.id, p.copy.ru.name]));
    const rooms = await listRooms(db.pool);
    assert.deepEqual(rooms.map((r) => [r.id, r.name]), birthdayRooms.map((r) => [r.id, r.name]));
    assert.deepEqual(rooms.map((r) => r.id), ["roblox-room", "ice-room", "magic-room", "rapunzel-room"]);
    const summary = await catalogSummary(db.pool);
    for (const site of birthdayPackages) {
      const row = summary.packages.find((p) => p.id === site.id)!;
      assert.equal(row.basePrice, site.weekendPrice, `${site.id} base`);
      assert.equal(row.weekdayPrice, site.weekdayPrice, `${site.id} weekday`);
    }
    assert.equal(summary.slots.length, 3);
    assert.deepEqual((await listSlots(db.pool)).map((s) => `${s.startsAt}-${s.endsAt}`), ["10:00-14:00", "14:00-18:00", "18:00-22:00"]);
  });

  it("seeding again changes nothing and never overwrites prices set in the admin", async () => {
    await setPriceRule(db.pool, owner, { packageId: "boom-bala-party", ruleType: "base", amountKzt: 85000 });
    const again = await seedFromSite(db.pool);
    assert.deepEqual(again, { packagesAdded: 0, roomsAdded: 0, priceRulesAdded: 0 });
    assert.equal((await resolvePrice(db.pool, "boom-bala-party", "2027-03-06"))!.amountKzt, 85000); // a Saturday: regular price
    await setPriceRule(db.pool, owner, { packageId: "boom-bala-party", ruleType: "base", amountKzt: 114900 }); // restore for later tests
  });

  it("weekday detection uses the calendar date", () => {
    assert.ok(isWeekday("2027-03-05")); // Friday
    assert.ok(!isWeekday("2027-03-06")); // Saturday
    assert.ok(!isWeekday("2027-03-07")); // Sunday
    assert.ok(isWeekday("2027-03-08")); // Monday
  });

  it("price hierarchy: special date > weekday (Mon-Fri) > regular", async () => {
    const wow = birthdayPackages.find((p) => p.id === "star-party")!;
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2027-04-07"), { amountKzt: wow.weekdayPrice, source: "weekday" }); // Wednesday
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2027-04-10"), { amountKzt: wow.weekendPrice, source: "base" }); // Saturday
    await setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "date", date: "2027-04-07", amountKzt: 41000, note: "праздничный день" });
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2027-04-07"), { amountKzt: 41000, source: "date" });
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2027-04-08"), { amountKzt: wow.weekdayPrice, source: "weekday" }); // neighbours unaffected
    // other packages are unaffected
    assert.equal((await resolvePrice(db.pool, "happy-party", "2027-04-07"))!.source, "weekday");
    // removing the special price falls back to the weekday price
    await setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "date", date: "2027-04-07", amountKzt: null });
    assert.deepEqual(await resolvePrice(db.pool, "star-party", "2027-04-07"), { amountKzt: wow.weekdayPrice, source: "weekday" });
  });

  it("keeps the whole price history and records who changed it", async () => {
    await setPriceRule(db.pool, owner, { packageId: "happy-party", ruleType: "weekday", amountKzt: 30000, note: "акция" });
    await setPriceRule(db.pool, owner, { packageId: "happy-party", ruleType: "weekday", amountKzt: 38430 });
    const history = await priceHistory(db.pool, owner, "happy-party");
    const weekday = history.filter((h) => h.ruleType === "weekday").map((h) => h.amountKzt);
    assert.deepEqual(weekday.slice(0, 3), [38430, 30000, 38430]); // newest first, original seed last of the three
    assert.equal(history[0].createdBy, "Test owner");
    const audit = await db.pool.query("SELECT before, after FROM audit_log WHERE action = 'price.set' AND entity_id = 'happy-party' ORDER BY id");
    assert.equal(audit.rowCount, 2);
    assert.equal(audit.rows[0].after.amountKzt, 30000);
    assert.equal(audit.rows[0].before.amountKzt, 38430);
  });

  it("validates price input and permissions", async () => {
    for (const bad of [0, -5, 1.5, 200_000_000]) {
      await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "base", amountKzt: bad }), ValidationError);
    }
    await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "base", amountKzt: null }), ValidationError);
    await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "date", amountKzt: 1000 }), ValidationError); // no date
    await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "date", date: "2027-13-40", amountKzt: 1000 }), ValidationError);
    await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "star-party", ruleType: "weekday", date: "2027-04-07", amountKzt: 1000 }), ValidationError);
    await assert.rejects(() => setPriceRule(db.pool, owner, { packageId: "no-such", ruleType: "base", amountKzt: 1000 }), ValidationError);
    for (const role of ["manager", "editor"] as const) {
      const u = await makeUser(db.pool, role, `${role}-prices@example.test`);
      await assert.rejects(() => setPriceRule(db.pool, { id: u.id, role }, { packageId: "star-party", ruleType: "base", amountKzt: 1000 }), ForbiddenError);
      await assert.rejects(() => priceHistory(db.pool, { id: u.id, role }, "star-party"), ForbiddenError);
    }
    await assert.rejects(() => resolvePrice(db.pool, "star-party", "not-a-date"), ValidationError);
  });
});
