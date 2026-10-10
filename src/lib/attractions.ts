import type { Attraction, Range } from "@/types";

export interface LimitItem {
  id: string;
  label: string;
  value: string;
  /** `true` = the value is not known yet and the visitor should ask the operator. */
  pending?: boolean;
}

function formatRange(r: Range, unit: string): string | null {
  const { min, max } = r;
  if (min !== undefined && max !== undefined) return `${min}–${max} ${unit}`;
  if (min !== undefined) return `от ${min} ${unit}`;
  if (max !== undefined) return `до ${max} ${unit}`;
  return null;
}

/** Visible limits in a fixed order: age, height, weight, extra requirements, then "to clarify". */
export function limitItems(a: Attraction): LimitItem[] {
  const out: LimitItem[] = [];
  const { age, height, weight, other, toClarify } = a.limits;
  const add = (id: string, label: string, r: Range | undefined, unit: string) => {
    const value = r && formatRange(r, unit);
    if (value) out.push({ id, label, value });
  };
  add("age", "Возраст", age, "лет");
  add("height", "Рост", height, "см");
  add("weight", "Вес", weight, "кг");
  other?.forEach((text, i) => out.push({ id: `other-${i}`, label: "Важно", value: text }));
  toClarify?.forEach((label, i) => out.push({ id: `clarify-${i}`, label, value: "уточняйте у оператора", pending: true }));
  return out;
}
