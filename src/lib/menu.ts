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

/** Group -> blocks of items, preserving the data order. Original sub-structure (e.g. sushi vs sauces) is kept. */
export function buildMenuView(catalog: MenuCatalog): MenuGroupView[] {
  return catalog.groups.map((group) => {
    const blocks: MenuBlock[] = [];
    for (const categoryId of group.categoryIds) {
      const category = catalog.categories.find((c) => c.id === categoryId);
      if (!category) continue;
      const inCategory = catalog.items.filter((i) => i.categoryId === categoryId);
      if (category.subgroups?.length) {
        for (const sub of category.subgroups) {
          blocks.push({ id: `${categoryId}:${sub.id}`, title: sub.name, items: inCategory.filter((i) => i.subgroupId === sub.id) });
        }
      } else {
        blocks.push({ id: categoryId, title: category.name, items: inCategory });
      }
    }
    if (blocks.length === 1) blocks[0].title = null;
    const all = blocks.flatMap((b) => b.items);
    const excluded = new Set(
      catalog.categories.flatMap((c) => (c.subgroups ?? []).filter((s) => s.excludeFromMinPrice).map((s) => `${c.id}:${s.id}`)),
    );
    const priced = blocks.filter((b) => !excluded.has(b.id)).flatMap((b) => b.items);
    return { group, blocks, count: all.length, minPrice: Math.min(...(priced.length ? priced : all).map((i) => i.price)) };
  });
}
