import { menuCatalog } from "@/data/menu";
import type { MenuCatalog } from "@/types";

/**
 * The cafe menu comes from src/data/menu.ts only (the venue's official PDF is the single source).
 * It deliberately does NOT go through `resolve()`: if NEXT_PUBLIC_API_BASE_URL were ever set, an API
 * answer for /menu must not be able to put an outdated menu back on the site.
 */
export async function getMenu(): Promise<MenuCatalog> {
  return menuCatalog;
}
