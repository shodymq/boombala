// Pricing V4 checks on the typed birthday config: the approved numbers, the programme with its minutes and options, the flags,
// the RU/KZ copy. Runs the real TypeScript module (no copy of the logic): `npm run test:birthday-packages`.
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

register("./ts-loader.mjs", import.meta.url);
const { birthdayPackages, APPROVED_PRICES, RETIRED_PACKAGE_IDS, isPackageId } = await import("../src/data/birthdays.ts");
const { BIRTHDAYS_UI } = await import("../src/data/birthdays-ui.ts");
const { PACKAGE_OPTIONS, validateLead } = await import("../src/lib/lead.ts");
const source = JSON.parse(await readFile(new URL("../src/data/birthday-packages-v4.json", import.meta.url), "utf8"));

const byId = Object.fromEntries(birthdayPackages.map((p) => [p.id, p]));
const minutes = (id) => byId[id].copy.ru.program.reduce((sum, i) => sum + i.minutes, 0);

describe("Pricing V4: the packages on sale", () => {
  it("exactly three active packages, in the approved order", () => {
    assert.deepEqual(birthdayPackages.map((p) => p.id), ["happy-party", "star-party", "boom-bala-party"]);
  });

  it("regular, weekday and savings prices are the approved tenge amounts", () => {
    for (const [id, want] of Object.entries(APPROVED_PRICES)) {
      assert.equal(byId[id].weekendPrice, want.weekend, `${id} weekend`);
      assert.equal(byId[id].weekdayPrice, want.weekday, `${id} weekday`);
      assert.equal(byId[id].weekdaySavings, want.savings, `${id} savings`);
    }
    assert.deepEqual(APPROVED_PRICES["happy-party"], { weekend: 54900, weekday: 38430, savings: 16470 });
    assert.deepEqual(APPROVED_PRICES["star-party"], { weekend: 79900, weekday: 55930, savings: 23970 });
    assert.deepEqual(APPROVED_PRICES["boom-bala-party"], { weekend: 114900, weekday: 80430, savings: 34470 });
  });

  it("weekday = 70% of weekend, a whole number of tenge; savings add up", () => {
    for (const p of birthdayPackages) {
      assert.equal(p.weekdayPrice, (p.weekendPrice * 70) / 100, p.id);
      assert.equal(p.weekdayPrice + p.weekdaySavings, p.weekendPrice, p.id);
    }
  });

  it("the V3 prices and the old prices are not offered any more", () => {
    const active = JSON.stringify(birthdayPackages);
    for (const old of ["94430", "94 430", "134900", "134 900", "79990", "79 990", "44900", "44 900", "37900", "37 900"]) {
      assert.equal(active.includes(old), false, `retired price ${old} must not be offered`);
    }
    for (const retired of RETIRED_PACKAGE_IDS) assert.equal(isPackageId(retired), false, `${retired} is not on sale`);
  });
});

describe("Pricing V4: the programme, minute by minute", () => {
  it("the items add up to the declared length: Happy 60, Star 90, Boom Bala 150 minutes", () => {
    assert.equal(minutes("happy-party"), 60);
    assert.equal(minutes("star-party"), 90);
    assert.equal(minutes("boom-bala-party"), 150);
    for (const p of birthdayPackages) assert.equal(p.durationMinutes, minutes(p.id), p.id);
  });

  it("the headline facts of the approved table", () => {
    const want = {
      "happy-party": { kids: 6, guests: 5, animators: 1, selectable: false, adults: 0, shows: 1, workshop: null, challenge: false, welcome: false, pinata: false, invitation: false, photo: false, figures: "included", badge: null },
      "star-party": { kids: 7, guests: 6, animators: 2, selectable: true, adults: 0, shows: 2, workshop: null, challenge: true, welcome: false, pinata: false, invitation: false, photo: false, figures: "included", badge: "optimal" },
      "boom-bala-party": { kids: 10, guests: 9, animators: 2, selectable: true, adults: 3, shows: 2, workshop: "premium", challenge: true, welcome: true, pinata: true, invitation: true, photo: true, figures: "not_included", badge: "flagship" },
    };
    for (const [id, w] of Object.entries(want)) {
      const p = byId[id];
      assert.equal(p.kidsIncluded, w.kids, `${id} kids incl. birthday child`);
      assert.equal(p.guestsIncluded, w.guests, `${id} guests on top`);
      assert.equal(p.animators, w.animators, `${id} animators`);
      assert.equal(p.animatorsSelectable, w.selectable, `${id} animators selectable`);
      assert.equal(p.adultsIncluded, w.adults, `${id} adults`);
      assert.equal(p.showCount, w.shows, `${id} shows`);
      assert.equal(p.workshop, w.workshop, `${id} workshop`);
      assert.equal(p.challengeIncluded, w.challenge, `${id} challenge`);
      assert.equal(p.welcome, w.welcome, `${id} welcome`);
      assert.equal(p.pinata, w.pinata, `${id} piñata`);
      assert.equal(p.invitation, w.invitation, `${id} invitation`);
      assert.equal(p.photo, w.photo, `${id} photo`);
      assert.equal(p.figures, w.figures, `${id} figures`);
      assert.equal(p.badge, w.badge, `${id} badge`);
    }
  });

  it("Star has no workshop and no welcome; the cake is never part of a price", () => {
    assert.equal(byId["star-party"].workshop, null);
    assert.equal(byId["star-party"].welcome, false);
    for (const p of birthdayPackages) assert.ok(!/кейк|торт включ/i.test(JSON.stringify(p.copy.ru)), `${p.id}: no claim that the cake is included`);
  });

  it("the choices: a fixed item has no options, a choice has as many options as it allows", () => {
    const pick = (id, fragment) => byId[id].copy.ru.program.find((i) => i.title.includes(fragment));
    assert.equal(pick("star-party", "WOW").pick, 2);
    assert.equal(pick("star-party", "WOW").options.length, 4);
    assert.equal(pick("boom-bala-party", "Два шоу").pick, 2);
    assert.equal(pick("boom-bala-party", "Два шоу").options.length, 4);
    assert.equal(pick("boom-bala-party", "премиальный").options.length, 4);
    assert.equal(pick("star-party", "челлендж").options.length, 4);
    assert.equal(pick("boom-bala-party", "челлендж").options.length, 4);
    // HAPPY: the show list is not confirmed, so the card says so instead of copying Star's or Boom's shows
    const happyShow = pick("happy-party", "Одно шоу");
    assert.equal(happyShow.pick, 1);
    assert.deepEqual(happyShow.options, []);
    assert.ok(happyShow.optionsNote, "HAPPY shows: the note says the manager confirms the list");
    for (const p of birthdayPackages) {
      for (const item of p.copy.ru.program) {
        if (item.pick === 0) assert.deepEqual(item.options, [], `${p.id} ${item.title}: a fixed item has no options`);
        else if (item.options.length) assert.ok(item.pick <= item.options.length, `${p.id} ${item.title}: can pick at most as many as offered`);
      }
    }
  });

  it("Russian and Kazakh programmes have the same items, minutes and choices", () => {
    for (const p of birthdayPackages) {
      assert.equal(p.copy.kk.program.length, p.copy.ru.program.length, `${p.id} items`);
      p.copy.kk.program.forEach((item, n) => {
        assert.equal(item.minutes, p.copy.ru.program[n].minutes, `${p.id} minutes`);
        assert.equal(item.pick, p.copy.ru.program[n].pick, `${p.id} choice`);
      });
      assert.match(p.copy.kk.tag, /[әіңғүұқөһ]/i, `${p.id} kk tag is Kazakh`);
    }
  });

  it("the shared conditions: 4 hours, 20% extra children, 30% weekdays, all four rooms", () => {
    assert.equal(source.room_hours, 4);
    assert.equal(source.extra_child_discount, 20);
    assert.equal(source.discount, 30);
    const rooms = ["roblox-room", "ice-room", "magic-room", "rapunzel-room"];
    for (const p of birthdayPackages) {
      assert.equal(p.roomHours, 4, p.id);
      assert.equal(p.extraChildDiscountPct, 20, p.id);
      assert.equal(p.weekdayDiscountPct, 30, p.id);
      assert.deepEqual(p.eligibleRoomIds, rooms, p.id);
    }
  });

  it("no card lists a service the package does not include (no 'не включён' wording in the sales copy)", () => {
    for (const p of birthdayPackages) {
      for (const c of p.copy.ru.conditions) assert.ok(!/не включ|не входит/i.test(c.title + c.note), `${p.id}: ${c.title}`);
    }
  });
});

describe("interface and lead form", () => {
  it("every interface string exists in both locales with the same kinds", () => {
    assert.deepEqual(Object.keys(BIRTHDAYS_UI.kk).sort(), Object.keys(BIRTHDAYS_UI.ru).sort());
    for (const key of Object.keys(BIRTHDAYS_UI.ru)) assert.equal(typeof BIRTHDAYS_UI.kk[key], typeof BIRTHDAYS_UI.ru[key], key);
  });

  it("the lead form offers exactly the three packages plus 'not decided'", () => {
    assert.deepEqual(PACKAGE_OPTIONS.map((o) => o.value), ["happy-party", "star-party", "boom-bala-party", "undecided"]);
  });

  it("a retired id is passed through unchanged (the platform decides what is on sale, never a silent replacement)", () => {
    for (const retired of RETIRED_PACKAGE_IDS) {
      const r = validateLead({ name: "Айгуль", phone: "+77071234567", date: "2099-05-10", consent: true, package: retired });
      assert.equal(r.ok, true, retired);
      assert.equal(r.data.package, retired, retired);
    }
    const ok = validateLead({ name: "Айгуль", phone: "+77071234567", date: "2099-05-10", consent: true, package: "boom-bala-party" });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.package, "boom-bala-party");
  });
});
