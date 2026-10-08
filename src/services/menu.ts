import { menuCatalog } from "@/data/menu";
import type { MenuCatalog } from "@/types";
import { resolve } from "./http";

/** GET /menu */
export function getMenu(): Promise<MenuCatalog> {
  return resolve("/menu", () => menuCatalog);
}
