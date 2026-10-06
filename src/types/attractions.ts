export interface Attraction {
  id: string;
  /** `null` until the real name is confirmed. */
  name: string | null;
  description: string | null;
  /** Public path or URL. `null` until a real photo is supplied. */
  image: string | null;
  imageAlt?: string;
}
