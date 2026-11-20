import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePricing, remainingFor, validateSelections, type PackageTerms, type PricingInput } from "../src/core/booking-pricing.ts";

const star: PackageTerms = {
  packageId: "star-party", version: "v4.2", includedChildren: 7, includedAdults: 0, animators: 2, programMinutes: 90, roomMinutes: 240, extraChildDiscountPct: 20,
  cakeCeremony: true, onlineInvitation: false,
  rules: [
    { kind: "animation", pickCount: 1, minutes: 20, options: ["active-games", "board-games", "toddler-interactive"] },
    { kind: "show", pickCount: 2, minutes: 30, options: ["silver-show", "neon-show", "dino-show", "mystery-box"] },
    { kind: "challenge", pickCount: 1, minutes: 15, options: ["guess-drink", "fortune-wheel", "shakers", "bottle-challenge"] },
  ],
};
const boom: PackageTerms = {
  packageId: "boom-bala-party", version: "v4.2", includedChildren: 10, includedAdults: 3, animators: 2, programMinutes: 150, roomMinutes: 240, extraChildDiscountPct: 20,
  cakeCeremony: true, onlineInvitation: true,
  rules: [
    { kind: "show", pickCount: 2, minutes: 35, options: ["neon-show", "silver-show", "mystery-box", "dino-show", "cotton-candy-show", "beauty-bar"] },
    { kind: "master_class", pickCount: 1, minutes: 30, options: ["slime", "kapitoshka", "name-bracelet", "cap-painting", "canvas-painting", "keychain-painting"] },
    { kind: "challenge", pickCount: 1, minutes: 15, options: ["shakers", "guess-drink", "fortune-wheel", "bottle-challenge"] },
    { kind: "animation", pickCount: 0, minutes: 30, options: [] },
  ],
};

const base = (over: Partial<PricingInput>): PricingInput => ({
  basePriceKzt: 79900, terms: star, headcountMode: "exact", childrenTotal: 7, adultsTotal: 0, childTariffKzt: null, adultTariffKzt: null,
  manualExtraChildrenKzt: null, manualExtraAdultsKzt: null, servicesKzt: 0, mealKzt: 0, ...over,
});

describe("Pricing V4.2: program selection", () => {
  it("a draft may be empty or partial; approval needs every included pick", () => {
    assert.deepEqual(validateSelections(star, [], false), {});
    assert.deepEqual(validateSelections(star, [{ kind: "show", optionId: "silver-show" }], false), {});
    const partial = validateSelections(star, [{ kind: "show", optionId: "silver-show" }], true);
    assert.deepEqual(Object.keys(partial).sort(), ["animation", "challenge", "show"]);
    const full = validateSelections(star, [
      { kind: "animation", optionId: "active-games" }, { kind: "show", optionId: "silver-show" }, { kind: "show", optionId: "neon-show" }, { kind: "challenge", optionId: "shakers" },
    ], true);
    assert.deepEqual(full, {});
  });

  it("refuses a show that is not in the package, a repeated pick, too many picks and a kind the package does not include", () => {
    assert.ok(validateSelections(star, [{ kind: "show", optionId: "beauty-bar" }], false).show, "beauty-bar is Boom Bala only");
    assert.ok(validateSelections(star, [{ kind: "show", optionId: "silver-show" }, { kind: "show", optionId: "silver-show" }], false).show, "no duplicates");
    assert.ok(validateSelections(star, ["silver-show", "neon-show", "dino-show"].map((optionId) => ({ kind: "show" as const, optionId })), false).show, "two shows only");
    assert.ok(validateSelections(star, [{ kind: "master_class", optionId: "slime" }], false).master_class, "Star has no master class");
    assert.ok(validateSelections(boom, [{ kind: "animation", optionId: "active-games" }], false).animation, "Boom Bala animation is a fixed block");
  });

  it("Boom Bala: 2 shows of 6, 1 master class of 6, 1 challenge", () => {
    const ok = validateSelections(boom, [
      { kind: "show", optionId: "beauty-bar" }, { kind: "show", optionId: "cotton-candy-show" }, { kind: "master_class", optionId: "slime" }, { kind: "challenge", optionId: "fortune-wheel" },
    ], true);
    assert.deepEqual(ok, {});
  });
});

describe("Pricing V4.2: amount", () => {
  it("the included headcount costs only the package price", () => {
    const r = computePricing(base({}));
    assert.deepEqual([r.extraChildren, r.extraAdults, r.totalKzt, r.status], [0, 0, 79900, "complete"]);
  });

  it("the 20% discount applies to the entrance of extra children only", () => {
    const r = computePricing(base({ childrenTotal: 9, adultsTotal: 2, childTariffKzt: 5000, adultTariffKzt: 3000 }));
    assert.equal(r.extraChildren, 2);
    assert.equal(r.extraChildrenKzt, 8000, "2 x 5000 x 0.8");
    assert.equal(r.extraAdultsKzt, 6000, "adults are not discounted");
    assert.equal(r.totalKzt, 79900 + 8000 + 6000);
  });

  it("services and meal are added without any discount", () => {
    const r = computePricing(base({ servicesKzt: 12000, mealKzt: 30000 }));
    assert.equal(r.totalKzt, 79900 + 12000 + 30000);
  });

  it("Boom Bala includes three adults", () => {
    const r = computePricing({ ...base({}), terms: boom, basePriceKzt: 114900, childrenTotal: 10, adultsTotal: 5, adultTariffKzt: 2500 });
    assert.deepEqual([r.extraAdults, r.extraAdultsKzt, r.totalKzt], [2, 5000, 119900]);
  });

  it("an unknown tariff is a gap, never an invented number: no total", () => {
    const r = computePricing(base({ childrenTotal: 9 }));
    assert.equal(r.status, "incomplete");
    assert.deepEqual(r.gaps, ["child_tariff_missing"]);
    assert.equal(r.totalKzt, null);
    assert.equal(remainingFor(r.totalKzt, 10000), null, "no total, no 'remaining'");
  });

  it("the manager's agreed amounts settle the gap", () => {
    const r = computePricing(base({ childrenTotal: 9, adultsTotal: 1, manualExtraChildrenKzt: 7000, manualExtraAdultsKzt: 2000 }));
    assert.deepEqual([r.status, r.gaps, r.totalKzt], ["complete", [], 79900 + 7000 + 2000]);
  });

  it("«по факту» and a missing headcount are incomplete until the manager agrees the extras", () => {
    assert.deepEqual(computePricing(base({ headcountMode: "by_fact" })).gaps, ["headcount_by_fact"]);
    assert.deepEqual(computePricing(base({ childrenTotal: null, adultsTotal: null })).gaps, ["headcount_missing"]);
    const settled = computePricing(base({ headcountMode: "by_fact", manualExtraChildrenKzt: 0, manualExtraAdultsKzt: 0 }));
    assert.deepEqual([settled.status, settled.totalKzt], ["complete", 79900]);
  });

  it("a booking without a package price or terms (an imported event) is never given an invented total", () => {
    assert.deepEqual(computePricing(base({ basePriceKzt: null })).gaps.includes("base_price_missing"), true);
    const legacy = computePricing(base({ terms: null }));
    assert.deepEqual([legacy.status, legacy.totalKzt, legacy.gaps], ["incomplete", null, ["terms_missing"]]);
  });

  it("remaining is the total minus the prepayment, never negative", () => {
    assert.equal(remainingFor(79900, 10000), 69900);
    assert.equal(remainingFor(5000, 10000), 0);
  });
});
