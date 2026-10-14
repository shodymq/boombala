import type { MenuCatalog, MenuGroup, MenuItem } from "@/types";

export interface MenuBlock {
  id: string;
  /** Sub-heading, e.g. "Пицца". `null` when the group has a single block (the group heading is enough). */
  title: string | null;
  items: MenuItem[];
}

export interface MenuGroupView {
  group: MenuGroup;
  blocks: MenuBlock[];
  count: number;
  /** Lowest price in the group, in KZT. */
  minPrice: number;
}

/** Group -> blocks (one per printed category), preserving the data order. */
export function buildMenuView(catalog: MenuCatalog): MenuGroupView[] {
  return catalog.groups.map((group) => {
    const blocks: MenuBlock[] = [];
    const excluded = new Set<string>();
    for (const categoryId of group.categoryIds) {
      const category = catalog.categories.find((c) => c.id === categoryId);
      if (!category) continue;
      const items = catalog.items.filter((i) => i.categoryId === categoryId);
      if (!items.length) continue; // never render an empty block
      blocks.push({ id: categoryId, title: category.name, items });
      if (category.excludeFromMinPrice) excluded.add(categoryId);
    }
    if (blocks.length === 1) blocks[0].title = null;
    const all = blocks.flatMap((b) => b.items);
    const priced = blocks.filter((b) => !excluded.has(b.id)).flatMap((b) => b.items);
    return { group, blocks, count: all.length, minPrice: Math.min(...(priced.length ? priced : all).map((i) => i.price)) };
  });
}
