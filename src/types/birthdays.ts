/** Stable machine ids. Not translated; the public URLs and the CRM store these. */
export type PackageId = "happy-party" | "star-party" | "boom-bala-party";

/** Site locales that carry package copy. `kk` is the Kazakh version (URL segment /kk). */
export type Locale = "ru" | "kk";

/** One line of "Что входит": a fixed item, or a choice of exactly one `options` entry. */
export interface ProgramItem {
  title: string;
  detail?: string;
  /** True when the guest chooses ONE of `options`; never shown as if all were included. */
  choice: boolean;
  options: string[];
}

export interface PackageCopy {
  name: string;
  tag: string;
  /** Two-line conditions as written in the approved Pricing V3 (title + note). */
  conditions: { title: string; note: string }[];
  program: ProgramItem[];
  /** Boom only: the closing block (piñata and photo). */
  finale: string[];
}

export type FiguresStatus = "included" | "not_included" | "not_stated";

/**
 * One birthday package. Numbers come from the approved Pricing V3 (`birthday-packages-v3.json`); the flags that are not in that
 * file come from the TS mapping in `src/data/birthdays.ts`, next to the approved table, so both are reviewed together.
 */
export interface BirthdayPackage {
  id: PackageId;
  sortOrder: number;
  /** Children INCLUDING the birthday child. */
  kidsIncluded: number;
  /** Guests on top of the birthday child, as sold. */
  guestsIncluded: number;
  adultsIncluded: number;
  /** Length of the animation/holiday programme (not the room rental). */
  durationMinutes: number;
  animators: number;
  /** "1 на выбор" / "2 на выбор": the guest chooses which animator(s) to book. */
  animatorsSelectable: boolean;
  roomHours: number;
  /** Regular (weekend) price in tenge, integer. */
  weekendPrice: number;
  /** Mon-Fri price in tenge, integer: weekendPrice * (100 - weekdayDiscountPct) / 100. */
  weekdayPrice: number;
  /** weekendPrice − weekdayPrice. */
  weekdaySavings: number;
  weekdayDiscountPct: number;
  extraChildDiscountPct: number;
  /** Shows / interactives chosen as ONE of the options (0 means none is included). */
  showCount: number;
  workshop: "standard" | "premium" | null;
  challengeIncluded: boolean;
  pinata: boolean;
  invitation: boolean;
  photo: boolean;
  figures: FiguresStatus;
  /** Cake carry-out ceremony is part of the programme. The cake itself is NOT promised. */
  cakeCarryOut: boolean;
  eligibleRoomIds: string[];
  /** Badge key for the card. Only approved labels; "most popular" is never used. */
  badge: "optimal" | "flagship" | null;
  copy: Record<Locale, PackageCopy>;
}
