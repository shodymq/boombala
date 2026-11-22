import { birthdayPackagesV4 } from "@/data/birthdays-v4";
import type { BirthdayPackage } from "@/types/birthdays-v4";

/** Pricing V4.2 is a versioned public-site catalogue; the CRM remains the validator for submitted package IDs. */
export function getBirthdayPackages(): Promise<BirthdayPackage[]> {
  return Promise.resolve(birthdayPackagesV4);
}
