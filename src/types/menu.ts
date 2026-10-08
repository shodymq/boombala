export interface MenuSubgroup {
  id: string;
  name: string;
  /** Cheap add-ons (e.g. sauces) should not define the "from X ₸" teaser price of their group. */
  excludeFromMinPrice?: boolean;
}

/** An original category of the printed menu (13 of them). */
export interface MenuCategory {
  id: string;
  name: string;
  /** Optional UI split inside one original category (e.g. "Суши и соусы" -> Суши / Соусы). */
  subgroups?: MenuSubgroup[];
}

/** A UI group on /menu: several original categories shown together. */
export interface MenuGroup {
  id: string;
  name: string;
  categoryIds: string[];
}

export interface MenuItem {
  id: string;
  name: string;
  /** Price in KZT (tenge). */
  price: number;
  categoryId: string;
  subgroupId?: string;
  /** Public path or URL of a menu image. `undefined` = text-only row. */
  image?: string;
  /** Only when confirmed. Never invent composition, weight or calories. */
  description?: string;
  /** Printed on the official menu but needs the venue to confirm before it is relied upon. */
  needsConfirmation?: boolean;
}

export interface MenuCatalog {
  categories: MenuCategory[];
  groups: MenuGroup[];
  items: MenuItem[];
}
