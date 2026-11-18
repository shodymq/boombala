import pricing from "./birthday-packages-v3.json" with { type: "json" };
import { birthdayRooms } from "./birthdayRooms";
import type { BirthdayPackage, FiguresStatus, Locale, PackageCopy, PackageId, ProgramItem } from "@/types";

/**
 * Birthday packages, Pricing V3 (approved 18.11.2026). Single source for the page, the cards, the comparison, the lead form options and
 * the server-side validation of `package`. Numbers and RU/KZ texts come from `birthday-packages-v3.json` (copied from the approved
 * `packages.json`). Flags that the JSON does not carry are written here next to the approved table; change them together with it.
 *
 * Retired packages (WOW, MAGIC, the old BOOM with 79 990 ₸) are NOT in this list. The CRM keeps them as inactive history.
 */

/** Maps the stable id to its key in the JSON file. */
const RAW_KEY: Record<PackageId, "happy" | "star" | "boom"> = {
  "happy-party": "happy",
  "star-party": "star",
  "boom-bala-party": "boom",
};

/** Flags the JSON does not carry (approved table, Pricing V3 section 3). */
const FLAGS: Record<PackageId, { animatorsSelectable: boolean; figures: FiguresStatus; cakeCarryOut: boolean; badge: BirthdayPackage["badge"] }> = {
  "happy-party": { animatorsSelectable: false, figures: "included", cakeCarryOut: false, badge: null },
  "star-party": { animatorsSelectable: true, figures: "included", cakeCarryOut: true, badge: "optimal" },
  // "Фигурки из шариков: Не заявлено" for the flagship: it is not promised, so it is not shown as included.
  "boom-bala-party": { animatorsSelectable: true, figures: "not_stated", cakeCarryOut: true, badge: "flagship" },
};

const PREFERRED_ORDER: PackageId[] = ["happy-party", "star-party", "boom-bala-party"];

/** Options of a choice item: "Активные игры / настольные игры / интерактив" -> three options. */
function toProgramItem(title: string, detail: string | undefined): ProgramItem {
  const choice = /на выбор|таңдау бойынша/i.test(title);
  const options = choice && detail ? detail.split(" / ").map((s) => s.trim()).filter(Boolean) : [];
  return { title, detail: choice ? undefined : detail, choice, options };
}

function copyFor(raw: (typeof pricing)["locales"]["ru"]["happy"]): PackageCopy {
  const finale = "final" in raw && Array.isArray(raw.final) ? raw.final : [];
  return {
    name: raw.name,
    tag: raw.tag,
    conditions: raw.conditions.map(([title, note]) => ({ title, note })),
    program: raw.program.map(([title, detail]) => toProgramItem(title, detail || undefined)),
    finale,
  };
}

function build(id: PackageId, sortOrder: number): BirthdayPackage {
  const key = RAW_KEY[id];
  const raw = pricing.packages[key];
  const discount = pricing.discount;
  // The weekday price is derived ONCE from the weekend price. A non-integer result is a data error: fail at load, never round silently.
  const weekdayFloat = (raw.weekend * (100 - discount)) / 100;
  if (!Number.isInteger(weekdayFloat)) throw new Error(`birthday package ${id}: weekday price ${weekdayFloat} is not a whole tenge amount`);
  const flags = FLAGS[id];
  const workshop = raw.workshop_type === null ? null : (raw.workshop_type as "standard" | "premium");
  // The JSON carries two representations of the workshop; they must agree, otherwise the card and the table would disagree.
  if (raw.workshop !== (workshop !== null)) throw new Error(`birthday package ${id}: workshop flag and workshop_type disagree`);

  return {
    id,
    sortOrder,
    kidsIncluded: raw.kids,
    guestsIncluded: raw.kids - 1,
    adultsIncluded: raw.adults,
    durationMinutes: raw.minutes,
    animators: raw.animators,
    animatorsSelectable: flags.animatorsSelectable,
    roomHours: pricing.room_hours,
    weekendPrice: raw.weekend,
    weekdayPrice: weekdayFloat,
    weekdaySavings: raw.weekend - weekdayFloat,
    weekdayDiscountPct: discount,
    extraChildDiscountPct: pricing.extra_child_discount,
    showCount: raw.shows,
    workshop,
    challengeIncluded: raw.challenge,
    pinata: raw.pinata,
    invitation: raw.invitation,
    photo: raw.photo,
    figures: flags.figures,
    cakeCarryOut: flags.cakeCarryOut,
    eligibleRoomIds: birthdayRooms.map((r) => r.id),
    badge: flags.badge,
    copy: {
      ru: copyFor(pricing.locales.ru[key]),
      kk: copyFor(pricing.locales.kz[key]),
    },
  };
}

export const birthdayPackages: BirthdayPackage[] = PREFERRED_ORDER.map((id, i) => build(id, i));

/** The approved price table, for tests and the visible copy checks. */
export const APPROVED_PRICES: Record<PackageId, { weekend: number; weekday: number; savings: number }> = {
  "happy-party": { weekend: 54900, weekday: 38430, savings: 16470 },
  "star-party": { weekend: 79900, weekday: 55930, savings: 23970 },
  "boom-bala-party": { weekend: 134900, weekday: 94430, savings: 40470 },
};

export const getPackage = (id: string): BirthdayPackage | undefined => birthdayPackages.find((p) => p.id === id);

export const packageCopy = (pkg: BirthdayPackage, locale: Locale): PackageCopy => pkg.copy[locale];

export const isPackageId = (value: string): value is PackageId => birthdayPackages.some((p) => p.id === value);

/** Retired ids. A visitor or an old cached page may still send one: it is not offered, and it never silently becomes another package. */
export const RETIRED_PACKAGE_IDS = ["wow-party", "magic-party", "boom-party"] as const;
