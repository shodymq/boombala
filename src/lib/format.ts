const NBSP = " ";

/** 37900 -> "37 900 ₸" (non-breaking spaces so the price never wraps). */
export function formatTenge(value: number): string {
  const digits = Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${digits}${NBSP}₸`;
}

/** 37900 -> "37 900" without the currency sign. */
export function formatNumber(value: number): string {
  return formatTenge(value).replace(`${NBSP}₸`, "");
}

export function formatPriceOrFree(value: number): string {
  return value === 0 ? "бесплатно" : formatTenge(value);
}

/** pluralize(3, ["вариант", "варианта", "вариантов"]) -> "варианта" */
export function pluralize(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
