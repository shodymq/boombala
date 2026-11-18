// Pricing V3 checks on the typed birthday config: the approved numbers, the derived prices, the option groups and the RU/KZ copy.
// Runs the real TypeScript module (no copy of the logic): `npm run test:birthday-packages`.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register("./ts-loader.mjs", import.meta.url);
const { birthdayPackages, APPROVED_PRICES, RETIRED_PACKAGE_IDS, isPackageId } = await import("../src/data/birthdays.ts");
const { BIRTHDAYS_UI } = await import("../src/data/birthdays-ui.ts");
const { PACKAGE_OPTIONS, validateLead } = await import("../src/lib/lead.ts");
const pricing = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../src/data/birthday-packages-v3.json", import.meta.url), "utf8"));

const byId = Object.fromEntries(birthdayPackages.map((p) => [p.id, p]));

describe("Pricing V3: the three packages on sale", () => {
  it("exactly three active packages, in the approved order", () => {
    assert.deepEqual(birthdayPackages.map((p) => p.id), ["happy-party", "star-party", "boom-bala-party"]);
    assert.deepEqual(birthdayPackages.map((p) => p.sortOrder), [0, 1, 2]);
  });

  it("regular, weekday and savings prices are the approved tenge amounts", () => {
    for (const [id, want] of Object.entries(APPROVED_PRICES)) {
      assert.equal(byId[id].weekendPrice, want.weekend, `${id} weekend`);
      assert.equal(byId[id].weekdayPrice, want.weekday, `${id} weekday`);
      assert.equal(byId[id].weekdaySavings, want.savings, `${id} savings`);
    }
    assert.deepEqual(APPROVED_PRICES["happy-party"], { weekend: 54900, weekday: 38430, savings: 16470 });
    assert.deepEqual(APPROVED_PRICES["star-party"], { weekend: 79900, weekday: 55930, savings: 23970 });
    assert.deepEqual(APPROVED_PRICES["boom-bala-party"], { weekend: 134900, weekday: 94430, savings: 40470 });
  });

  it("the weekday price is 70% of the weekend price, a whole number of tenge, and the savings add up", () => {
    for (const p of birthdayPackages) {
      assert.equal(p.weekdayPrice, (p.weekendPrice * 70) / 100, p.id);
      assert.equal(Number.isInteger(p.weekdayPrice), true, p.id);
      assert.equal(p.weekdayPrice + p.weekdaySavings, p.weekendPrice, p.id);
    }
  });

  it("the old prices are not in the active offer", () => {
    const active = JSON.stringify(birthdayPackages);
    for (const old of ["114900", "114 900", "80430", "80 430", "79990", "79 990", "44900", "37900"]) {
      assert.equal(active.includes(old), false, `old price ${old} must not be offered`);
    }
    for (const retired of RETIRED_PACKAGE_IDS) assert.equal(isPackageId(retired), false, `${retired} is not on sale`);
  });

  it("the approved table: children, minutes, animators, adults, shows, workshop, challenge, piñata, invitation, photo", () => {
    const want = {
      "happy-party": { kids: 6, guests: 5, minutes: 30, animators: 1, selectable: false, adults: 0, shows: 0, workshop: null, challenge: false, pinata: false, invitation: false, photo: false, figures: "included", cake: false, badge: null },
      "star-party": { kids: 7, guests: 6, minutes: 60, animators: 1, selectable: true, adults: 0, shows: 1, workshop: "standard", challenge: true, pinata: false, invitation: false, photo: false, figures: "included", cake: true, badge: "optimal" },
      "boom-bala-party": { kids: 10, guests: 9, minutes: 150, animators: 2, selectable: true, adults: 3, shows: 1, workshop: "premium", challenge: true, pinata: true, invitation: true, photo: true, figures: "not_stated", cake: true, badge: "flagship" },
    };
    for (const [id, w] of Object.entries(want)) {
      const p = byId[id];
      assert.equal(p.kidsIncluded, w.kids, `${id} kids incl. birthday child`);
      assert.equal(p.guestsIncluded, w.guests, `${id} guests on top`);
      assert.equal(p.durationMinutes, w.minutes, `${id} programme minutes`);
      assert.equal(p.animators, w.animators, `${id} animators`);
      assert.equal(p.animatorsSelectable, w.selectable, `${id} animators selectable`);
      assert.equal(p.adultsIncluded, w.adults, `${id} adults`);
      assert.equal(p.showCount, w.shows, `${id} shows`);
      assert.equal(p.workshop, w.workshop, `${id} workshop`);
      assert.equal(p.challengeIncluded, w.challenge, `${id} challenge`);
      assert.equal(p.pinata, w.pinata, `${id} piñata`);
      assert.equal(p.invitation, w.invitation, `${id} invitation`);
      assert.equal(p.photo, w.photo, `${id} photo`);
      assert.equal(p.figures, w.figures, `${id} figures`);
      assert.equal(p.cakeCarryOut, w.cake, `${id} cake carry-out (the cake itself is not promised)`);
      assert.equal(p.badge, w.badge, `${id} badge`);
    }
  });

  it("the shared conditions: 4 hours, 20% for extra children, 30% on weekdays, all four rooms in every package", () => {
    assert.equal(pricing.room_hours, 4);
    assert.equal(pricing.extra_child_discount, 20);
    assert.equal(pricing.discount, 30);
    const rooms = ["roblox-room", "ice-room", "magic-room", "rapunzel-room"];
    for (const p of birthdayPackages) {
      assert.equal(p.roomHours, 4, p.id);
      assert.equal(p.extraChildDiscountPct, 20, p.id);
      assert.equal(p.weekdayDiscountPct, 30, p.id);
      assert.deepEqual(p.eligibleRoomIds, rooms, p.id);
    }
  });

  it("the choice groups list every option, once each, and never as if all were included", () => {
    const options = (id, title) => byId[id].copy.ru.program.find((i) => i.title.includes(title));
    assert.equal(options("star-party", "WOW").options.length, 4);
    assert.equal(options("star-party", "мастер").options.length, 4);
    assert.equal(options("star-party", "челлендж").options.length, 4);
    assert.equal(options("boom-bala-party", "шоу").options.length, 4);
    assert.equal(options("boom-bala-party", "премиальный").options.length, 4);
    assert.equal(options("boom-bala-party", "челлендж").options.length, 4);
    for (const p of birthdayPackages) {
      for (const item of p.copy.ru.program) {
        if (item.choice) assert.ok(item.options.length >= 3, `${p.id} ${item.title}: a choice has its options`);
        else assert.deepEqual(item.options, [], `${p.id} ${item.title}: a fixed item has no options`);
      }
    }
    assert.equal(byId["boom-bala-party"].copy.ru.program.find((i) => i.title.includes("шоу")).options.includes("сладкая вата для всех детей"), true);
  });

  it("the Russian and Kazakh copy have the same structure, and the Kazakh copy is not Russian", () => {
    for (const p of birthdayPackages) {
      assert.equal(p.copy.kk.program.length, p.copy.ru.program.length, `${p.id} programme items`);
      assert.equal(p.copy.kk.conditions.length, p.copy.ru.conditions.length, `${p.id} conditions`);
      assert.notEqual(p.copy.kk.tag, p.copy.ru.tag, `${p.id} tag is translated`);
      // Kazakh is written in Cyrillic too, so the check is for letters that Russian does not have.
      assert.match(p.copy.kk.tag, /[әіңғүұқөһ]/i, `${p.id} kk tag is Kazakh`);
    }
    assert.equal(byId["boom-bala-party"].copy.kk.finale[0], "АЙРЫҚША ФИНАЛ");
  });

  it("every interface string exists in both locales with the same keys", () => {
    assert.deepEqual(Object.keys(BIRTHDAYS_UI.kk).sort(), Object.keys(BIRTHDAYS_UI.ru).sort());
    for (const key of Object.keys(BIRTHDAYS_UI.ru)) {
      const ru = BIRTHDAYS_UI.ru[key];
      const kk = BIRTHDAYS_UI.kk[key];
      assert.equal(typeof kk, typeof ru, key);
    }
    assert.equal(BIRTHDAYS_UI.kk.faq.length, BIRTHDAYS_UI.ru.faq.length);
  });

  it("the lead form offers exactly the three packages plus 'not decided'", () => {
    assert.deepEqual(PACKAGE_OPTIONS.map((o) => o.value), ["happy-party", "star-party", "boom-bala-party", "undecided"]);
  });

  it("a retired package from an old cached page is refused with a clear message, never silently replaced", () => {
    for (const retired of RETIRED_PACKAGE_IDS) {
      const r = validateLead({ name: "Айгуль", phone: "+77071234567", date: "2099-05-10", consent: true, package: retired });
      assert.equal(r.ok, false, retired);
      assert.match(r.errors.package, /больше не продаётся/, retired);
    }
    const ok = validateLead({ name: "Айгуль", phone: "+77071234567", date: "2099-05-10", consent: true, package: "boom-bala-party" });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.package, "boom-bala-party");
  });
});
