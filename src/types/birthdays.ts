export type PackageId = "wow-party" | "magic-party" | "boom-party";

/** Stable keys used to line packages up in the comparison matrix. */
export type ProgramKey =
  | "greeting"
  | "animation"
  | "characters"
  | "animators"
  | "quest"
  | "shows"
  | "workshop"
  | "challenge"
  | "pinata";

export interface ProgramItem {
  key: ProgramKey;
  title: string;
  /** How many options the guest picks / receives, shown in the matrix. */
  count?: number;
  /** Options listed on the official materials. */
  options?: string[];
  note?: string;
}

export interface BirthdayPackage {
  id: PackageId;
  name: string;
  /** Short name used in tight spaces (comparison matrix header). */
  shortName: string;
  tagline: string;
  /** Regular price in tenge. */
  price: number;
  /** Price on weekdays in tenge. */
  weekdayPrice: number;
  /**
   * True when `weekdayPrice` is printed on the official materials but does not match
   * `price` minus `weekdayDiscountPercent`. Needs confirmation from the venue; never auto-recalculate.
   */
  weekdayPriceNeedsConfirmation?: boolean;
  weekdayDiscountPercent: number;
  freeChildren: number;
  extraGuestDiscountPercent: number;
  program: ProgramItem[];
  /** Set only when it is derivable from the data (e.g. most complete program). */
  highlight?: string;
}
