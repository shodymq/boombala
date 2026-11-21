import pricing from "./birthday-packages-v4.json" with { type: "json" };
import { birthdayRooms } from "./birthdayRooms";
import type { BirthdayPackage, Locale, PackageCopy, PackageId, ProgramItem } from "@/types";

/**
 * Birthday packages, Pricing V4 (approved 2026-11-20; it replaces V3 before any release). The single source is
 * `birthday-packages-v4.json`: numbers, flags, programme items with their minutes and options, RU and KZ texts.
 * Everything here is derived from it and checked when the module loads: a mismatch fails the build or the test, never silently.
 *
 * The retired packages (WOW, MAGIC, the old BOOM) are not in this list. The CRM keeps them as inactive history.
 */

const RAW_KEY: Record<PackageId, "happy" | "star" | "boom"> = {
  "happy-party": "happy",
  "star-party": "star",
  "boom-bala-party": "boom",
};

const PREFERRED_ORDER: PackageId[] = ["happy-party", "star-party", "boom-bala-party"];

type RawItem = { title: string; minutes: number; detail: string | null; pick: number; options: string[]; options_note?: string; finale: boolean };
type RawCopy = { name: string; tag: string; conditions: [string, string][]; program: RawItem[] };

function toProgramItem(raw: RawItem): ProgramItem {
  const item: ProgramItem = {
    title: raw.title,
    minutes: raw.minutes,
    detail: raw.detail,
    pick: raw.pick,
    options: raw.options,
    finale: raw.finale,
  };
  if (raw.options_note) item.optionsNote = raw.options_note;
  return item;
}

function copyFor(raw: RawCopy): PackageCopy {
  return {
    name: raw.name,
    tag: raw.tag,
    conditions: raw.conditions.map(([title, note]) => ({ title, note })),
    program: raw.program.map(toProgramItem),
  };
}

function build(id: PackageId, sortOrder: number): BirthdayPackage {
  const key = RAW_KEY[id];
  const raw = pricing.packages[key];
  const ru = pricing.locales.ru[key] as RawCopy;
  const kz = pricing.locales.kz[key] as RawCopy;
  const discount = pricing.discount;

  // The weekday price is derived ONCE from the weekend price. A non-integer result is a data error.
  const weekdayFloat = (raw.weekend * (100 - discount)) / 100;
  if (!Number.isInteger(weekdayFloat)) throw new Error(`birthday package ${id}: weekday price ${weekdayFloat} is not a whole tenge amount`);
  if (weekdayFloat !== raw.weekday) throw new Error(`birthday package ${id}: weekday ${raw.weekday} does not equal 70% of ${raw.weekend}`);

  // The programme is the sum of its items; the declared length must match it.
  const minutes = ru.program.reduce((sum, i) => sum + i.minutes, 0);
  if (minutes !== raw.program_minutes) throw new Error(`birthday package ${id}: programme items add up to ${minutes} min, declared ${raw.program_minutes}`);
  if (kz.program.length !== ru.program.length || kz.program.some((i, n) => i.minutes !== ru.program[n].minutes || i.pick !== ru.program[n].pick)) {
    throw new Error(`birthday package ${id}: the Kazakh programme does not match the Russian one (items, minutes, choices)`);
  }
  // The workshop tier comes from the data flag. The public title is "1 мастер-класс на выбор" (no tier word), so the check is presence only.
  const workshopItem = ru.program.find((i) => /мастер-класс/i.test(i.title));
  const workshop = (raw.workshop ?? null) as "standard" | "premium" | null;
  if (Boolean(workshopItem) !== Boolean(workshop)) throw new Error(`birthday package ${id}: workshop flag and programme disagree`);

  return {
    id,
    sortOrder,
    kidsIncluded: raw.kids,
    guestsIncluded: raw.guests,
    adultsIncluded: raw.adults,
    durationMinutes: raw.program_minutes,
    animators: raw.animators,
    animatorsSelectable: raw.animators_selectable,
    roomHours: pricing.room_hours,
    weekendPrice: raw.weekend,
    weekdayPrice: weekdayFloat,
    weekdaySavings: raw.weekend - weekdayFloat,
    weekdayDiscountPct: discount,
    extraChildDiscountPct: pricing.extra_child_discount,
    showCount: raw.shows,
    workshop,
    challengeIncluded: raw.challenge,
    welcome: raw.welcome,
    pinata: raw.pinata,
    invitation: raw.invitation,
    photo: raw.photo,
    figures: raw.figures as BirthdayPackage["figures"],
    cakeCarryOut: raw.cake_ceremony,
    eligibleRoomIds: birthdayRooms.map((r) => r.id),
    badge: (raw.badge ?? null) as BirthdayPackage["badge"],
    copy: { ru: copyFor(ru), kk: copyFor(kz) },
  };
}

export const birthdayPackages: BirthdayPackage[] = PREFERRED_ORDER.map((id, i) => build(id, i));

/** The approved prices (Pricing V4), for the tests and the visible copy checks. */
export const APPROVED_PRICES: Record<PackageId, { weekend: number; weekday: number; savings: number }> = {
  "happy-party": { weekend: 54900, weekday: 38430, savings: 16470 },
  "star-party": { weekend: 79900, weekday: 55930, savings: 23970 },
  "boom-bala-party": { weekend: 114900, weekday: 80430, savings: 34470 },
};

export const getPackage = (id: string): BirthdayPackage | undefined => birthdayPackages.find((p) => p.id === id);

export const packageCopy = (pkg: BirthdayPackage, locale: Locale): PackageCopy => pkg.copy[locale];

export const isPackageId = (value: string): value is PackageId => birthdayPackages.some((p) => p.id === value);

/** Retired ids. A visitor or an old cached page may still send one: it is not offered, and it never silently becomes another package. */
export const RETIRED_PACKAGE_IDS = ["wow-party", "magic-party", "boom-party"] as const;
