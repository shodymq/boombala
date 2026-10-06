import { birthdayPackages } from "@/data/birthdays";
import type { BirthdayPackage } from "@/types";
import { resolve } from "./http";

/** GET /birthday-packages */
export function getBirthdayPackages(): Promise<BirthdayPackage[]> {
  return resolve("/birthday-packages", () => birthdayPackages);
}
