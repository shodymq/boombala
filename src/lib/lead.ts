import { siteConfig } from "@/services/config";

export const PACKAGE_OPTIONS = [
  { value: "wow-party", label: "WOW PARTY" },
  { value: "magic-party", label: "MAGIC PARTY" },
  { value: "boom-party", label: "BOOM PARTY" },
  { value: "undecided", label: "Ещё не определились" },
] as const;

export type LeadPackage = (typeof PACKAGE_OPTIONS)[number]["value"];

export interface LeadFields {
  name: string;
  phone: string;
  date: string; // YYYY-MM-DD
  children: string; // optional, digits
  package: LeadPackage;
  /** Explicit consent to personal data processing (required). */
  consent: boolean;
}

export type LeadErrors = Partial<Record<keyof LeadFields, string>>;

export const NAME_MAX = 80;

/** Today as YYYY-MM-DD in Asia/Almaty. */
export function almatyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: siteConfig.opening.timeZone }).format(now);
}

/** Earliest bookable date: not before today and not before the first working day. */
export function minBookingDate(now: Date = new Date()): string {
  const today = almatyToday(now);
  return today > siteConfig.opening.date ? today : siteConfig.opening.date;
}

/** Normalise to +7XXXXXXXXXX (KZ/RU) or +<international digits>. Returns null if invalid. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+") && !digits.startsWith("7")) {
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  let d = digits;
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length === 11 && d.startsWith("7") ? `+${d}` : null;
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validateLead(input: Partial<Record<keyof LeadFields, unknown>>): {
  ok: boolean;
  errors: LeadErrors;
  data?: { name: string; phone: string; date: string; children: number | null; package: LeadPackage };
} {
  const errors: LeadErrors = {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const name = str(input.name).replace(/\s+/g, " ");
  if (name.length < 2) errors.name = "Укажите имя";
  else if (name.length > NAME_MAX) errors.name = "Слишком длинное имя";

  const phone = normalizePhone(str(input.phone));
  if (!str(input.phone)) errors.phone = "Укажите телефон";
  else if (!phone) errors.phone = "Проверьте номер телефона";

  const date = str(input.date);
  if (!date) errors.date = "Выберите дату";
  else if (!isRealDate(date)) errors.date = "Проверьте дату";
  else if (date < minBookingDate()) errors.date = "Выберите дату не раньше начала работы";
  else if (date > "2100-01-01") errors.date = "Проверьте дату";

  let children: number | null = null;
  const childrenRaw = str(input.children);
  if (childrenRaw) {
    const n = Number(childrenRaw);
    if (!Number.isInteger(n) || n < 1 || n > 60) errors.children = "От 1 до 60";
    else children = n;
  }

  if (!(input.consent === true || input.consent === "true")) errors.consent = "Подтвердите согласие";

  const pkgRaw = str(input.package);
  const pkg = PACKAGE_OPTIONS.find((o) => o.value === pkgRaw)?.value;
  if (!pkg) errors.package = "Выберите пакет";

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, errors, data: { name, phone: phone!, date, children, package: pkg! } };
}
