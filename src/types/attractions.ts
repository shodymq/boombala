export interface AttractionPhoto {
  /** Public path of a real Boom Bala photo (already cropped / colour-corrected). */
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** Inclusive numeric range. Either side may be absent ("от 5 лет", "до 160 см"). */
export interface Range {
  min?: number;
  max?: number;
}

export interface AttractionLimits {
  /** Years. */
  age?: Range;
  /** Centimetres. */
  height?: Range;
  /** Kilograms. */
  weight?: Range;
  /** Other confirmed one-line requirements, e.g. "Только без обуви". */
  other?: string[];
  /**
   * Neutral line for attractions whose sign states no age/height/weight, e.g.
   * "Условия допуска уточняйте у оператора". Shown only when there are no numeric limits.
   */
  admissionNote?: string;
  /**
   * Limits that exist but are NOT confirmed yet (e.g. "минимальный рост"). The UI shows them as
   * "<name> — уточняйте у оператора" instead of guessing a value.
   */
  toClarify?: string[];
}

export interface Attraction {
  id: string;
  slug: string;
  name: string;
  /** Printed under the name on the official sign, e.g. "Воздушная горка". */
  subtitle?: string;
  /** One short sentence, only confirmed facts. */
  shortDescription?: string;
  /** First image is the main one. Empty until a confirmed photo exists. */
  images: AttractionPhoto[];
  limits: AttractionLimits;
  /** Admin-approved rule lines for the "Правила посещения" block. Empty until approved. */
  rules: string[];
  /**
   * Transcribed from the official sign but NOT yet approved by the administration. Stored for later;
   * never rendered. Move the lines to `rules` once approved (medical contraindications especially).
   */
  rulesDraft?: { items: string[]; footer?: string; source: string };
  /** Shown on the site only when true. Lets all 8 attractions live in data while only confirmed ones go public. */
  published: boolean;
  /** Candidate for the home page teaser (rendered in array order). */
  featured?: boolean;
  /** Internal notes: what still has to be confirmed before publishing. Never rendered. */
  needsConfirmation?: string[];
}
