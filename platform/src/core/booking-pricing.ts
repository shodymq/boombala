/**
 * Pure rules of Pricing V4.2 for a booking card: which entertainment a package may offer and how the amount is built.
 * No I/O. The data (package terms, tariffs) is loaded from the versioned catalog tables and passed in, so no business rule
 * lives in a component or a form. The server is the only authority: a price sent by a browser is never trusted.
 */

export type OptionKind = "show" | "master_class" | "challenge" | "animation";
export const OPTION_KINDS: readonly OptionKind[] = ["show", "master_class", "challenge", "animation"];

export interface ProgramRule {
  kind: OptionKind;
  /** How many options the client picks. 0 = a fixed block without a choice (for example the separate Boom Bala animation). */
  pickCount: number;
  minutes: number;
  /** Option ids this package offers for the kind. */
  options: string[];
}

export interface PackageTerms {
  packageId: string;
  version: string;
  includedChildren: number;
  includedAdults: number;
  animators: number;
  programMinutes: number;
  roomMinutes: number;
  extraChildDiscountPct: number;
  cakeCeremony: boolean;
  onlineInvitation: boolean;
  rules: ProgramRule[];
}

export interface Selection {
  kind: OptionKind;
  optionId: string;
}

/**
 * Checks a program selection against the package. `approval` is true when the program is being marked «Программа согласована»:
 * then every pick must be complete. A draft may be partial (the client does not decide everything on the first call).
 * Returns field errors keyed by kind; an empty object means valid.
 */
export function validateSelections(terms: PackageTerms, selections: Selection[], approval: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const perKind = new Map<OptionKind, number>();
  for (const s of selections) {
    const rule = terms.rules.find((r) => r.kind === s.kind);
    if (!rule || rule.pickCount === 0) {
      errors[s.kind] = "В этот пакет такой выбор не входит";
      continue;
    }
    if (!rule.options.includes(s.optionId)) {
      errors[s.kind] = "Этого варианта нет в выбранном пакете";
      continue;
    }
    // The same activity cannot fill two included slots without an approved business rule (none exists).
    if (seen.has(s.optionId)) {
      errors[s.kind] = "Один и тот же вариант нельзя выбрать дважды";
      continue;
    }
    seen.add(s.optionId);
    perKind.set(s.kind, (perKind.get(s.kind) ?? 0) + 1);
  }
  for (const rule of terms.rules) {
    if (rule.pickCount === 0) continue;
    const picked = perKind.get(rule.kind) ?? 0;
    if (picked > rule.pickCount) errors[rule.kind] = `В пакет входит не более ${rule.pickCount}`;
    else if (approval && picked < rule.pickCount) errors[rule.kind] = `Нужно выбрать: ${rule.pickCount}`;
  }
  return errors;
}

export interface PricingInput {
  /** The amount frozen on the reservation when it was agreed. Null when the booking has no package (an imported event). */
  basePriceKzt: number | null;
  terms: PackageTerms | null;
  headcountMode: "exact" | "by_fact";
  childrenTotal: number | null;
  adultsTotal: number | null;
  /** Approved entrance tariffs, or null when the business has not approved one yet. */
  childTariffKzt: number | null;
  adultTariffKzt: number | null;
  /** An amount the manager agreed by hand; it replaces the calculated one. */
  manualExtraChildrenKzt: number | null;
  manualExtraAdultsKzt: number | null;
  servicesKzt: number;
  mealKzt: number;
}

export type PricingGap = "base_price_missing" | "terms_missing" | "headcount_by_fact" | "headcount_missing" | "child_tariff_missing" | "adult_tariff_missing";

export interface PricingResult {
  extraChildren: number | null;
  extraAdults: number | null;
  extraChildrenKzt: number | null;
  extraAdultsKzt: number | null;
  servicesKzt: number;
  mealKzt: number;
  /** Null while any component is unknown: a partial sum is never presented as the price. */
  totalKzt: number | null;
  status: "complete" | "incomplete";
  gaps: PricingGap[];
}

/**
 * Extra children = max(0, children - included); extra adults = max(0, adults - included). The 20% discount applies to the
 * entrance of extra children ONLY (never to the package, adults or services). An unknown tariff or an unknown headcount is
 * reported as a gap for the manager to settle by hand; nothing is invented.
 */
export function computePricing(input: PricingInput): PricingResult {
  const gaps: PricingGap[] = [];
  const base = input.basePriceKzt;
  if (base === null) gaps.push("base_price_missing");

  let extraChildren: number | null = null;
  let extraAdults: number | null = null;
  let extraChildrenKzt: number | null = null;
  let extraAdultsKzt: number | null = null;

  const known = input.headcountMode === "exact" && input.terms !== null;
  if (input.terms === null && base !== null) gaps.push("terms_missing");
  if (input.headcountMode === "by_fact") gaps.push("headcount_by_fact");
  else if (input.terms && (input.childrenTotal === null || input.adultsTotal === null)) gaps.push("headcount_missing");

  if (known && input.terms) {
    if (input.childrenTotal !== null) extraChildren = Math.max(0, input.childrenTotal - input.terms.includedChildren);
    if (input.adultsTotal !== null) extraAdults = Math.max(0, input.adultsTotal - input.terms.includedAdults);
  }

  // Children.
  if (input.manualExtraChildrenKzt !== null) {
    extraChildrenKzt = input.manualExtraChildrenKzt;
  } else if (extraChildren !== null) {
    if (extraChildren === 0) extraChildrenKzt = 0;
    else if (input.childTariffKzt === null) gaps.push("child_tariff_missing");
    else extraChildrenKzt = Math.round((extraChildren * input.childTariffKzt * (100 - (input.terms?.extraChildDiscountPct ?? 0))) / 100);
  }
  // Adults.
  if (input.manualExtraAdultsKzt !== null) {
    extraAdultsKzt = input.manualExtraAdultsKzt;
  } else if (extraAdults !== null) {
    if (extraAdults === 0) extraAdultsKzt = 0;
    else if (input.adultTariffKzt === null) gaps.push("adult_tariff_missing");
    else extraAdultsKzt = extraAdults * input.adultTariffKzt;
  }

  // The headcount gaps are settled once the manager agreed both extras by hand.
  if (input.manualExtraChildrenKzt !== null && input.manualExtraAdultsKzt !== null) {
    for (const g of ["headcount_by_fact", "headcount_missing", "terms_missing"] as const) removeGap(gaps, g, true);
  }

  const parts = [base, extraChildrenKzt, extraAdultsKzt];
  const complete = gaps.length === 0 && parts.every((p) => p !== null);
  return {
    extraChildren,
    extraAdults,
    extraChildrenKzt,
    extraAdultsKzt,
    servicesKzt: input.servicesKzt,
    mealKzt: input.mealKzt,
    totalKzt: complete ? (base as number) + (extraChildrenKzt as number) + (extraAdultsKzt as number) + input.servicesKzt + input.mealKzt : null,
    status: complete ? "complete" : "incomplete",
    gaps,
  };
}

function removeGap(gaps: PricingGap[], gap: PricingGap, when: boolean): void {
  if (!when) return;
  const i = gaps.indexOf(gap);
  if (i >= 0) gaps.splice(i, 1);
}

/** Remaining amount, only when the total is known. A missing total is never shown as zero debt. */
export function remainingFor(totalKzt: number | null, paidKzt: number): number | null {
  return totalKzt === null ? null : Math.max(totalKzt - paidKzt, 0);
}
