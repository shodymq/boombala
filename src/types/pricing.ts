export type AgeBandId = "infant" | "toddler" | "child";

export interface PriceRow {
  id: AgeBandId;
  /** Human label, e.g. "С 3 до 15 лет". */
  label: string;
  /** Price in tenge. `0` means free. */
  price: number;
}

export interface PriceCategory {
  id: "weekday" | "weekend";
  title: string;
  rows: PriceRow[];
}

export interface PricePerk {
  id: string;
  label: string;
  /** Short value shown next to the label, e.g. "бесплатно" or "скидка 30%". */
  value: string;
}

export interface PricingTable {
  categories: PriceCategory[];
  perks: PricePerk[];
  companionPrice: number;
}
