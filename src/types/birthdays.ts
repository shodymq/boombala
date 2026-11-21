/** Stable machine ids. Not translated; the public URLs and the CRM store these. */
export type PackageId = "happy-party" | "star-party" | "boom-bala-party";

/** Site locales that carry package copy. `kk` is the Kazakh version (URL segment /kk). */
export type Locale = "ru" | "kk";

/** One line of "Что входит" with its own duration. `pick` options are chosen by the guest (0 = a fixed item, no choice). */
export interface ProgramItem {
  title: string;
  minutes: number;
  detail: string | null;
  pick: number;
  options: string[];
  /** Shown as a short note under the options (e.g. the Happy show list is confirmed by the manager). */
  optionsNote?: string;
  /** The closing block of the programme (e.g. the Star package finale). */
  finale: boolean;
}

export interface PackageCopy {
  name: string;
  tag: string;
  /** Approved conditions. A condition is only what is INCLUDED; absent services are never listed in a card. */
  conditions: { title: string; note: string }[];
  program: ProgramItem[];
}

export type FiguresStatus = "included" | "not_included";

/**
 * One birthday package (Pricing V4, approved 2026-11-20). Every number and flag comes from `birthday-packages-v4.json`; the TS mapping
 * only derives values from it.
 */
export interface BirthdayPackage {
  id: PackageId;
  sortOrder: number;
  /** Children INCLUDING the birthday child. */
  kidsIncluded: number;
  /** Guests on top of the birthday child, as sold. */
  guestsIncluded: number;
  adultsIncluded: number;
  /** Total length of the holiday programme (the sum of its items). Not the room rental (4 hours). */
  durationMinutes: number;
  animators: number;
  /** The guest chooses which animator(s) to book. */
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
  /** Number of shows / interactives included (Happy 1, Star 2, Boom 2). */
  showCount: number;
  workshop: "standard" | "premium" | null;
  challengeIncluded: boolean;
  welcome: boolean;
  invitation: boolean;
  photo: boolean;
  figures: FiguresStatus;
  /** The cake ceremony (carry-out) is in the programme. The cake itself is NOT included in any package. */
  cakeCarryOut: boolean;
  eligibleRoomIds: string[];
  badge: "optimal" | "flagship" | null;
  copy: Record<Locale, PackageCopy>;
}
