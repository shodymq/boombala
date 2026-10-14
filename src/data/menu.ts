import type { MenuCatalog, MenuCategory, MenuGroup, MenuItem } from "@/types";

/**
 * Cafe menu: the venue's current official menu ("Алуа_меню_Boombala.pdf", 2 pages: КУХНЯ and БАР, 58 items).
 * It is the ONLY source: anything not in that PDF is not on the site. Names and prices are copied as printed.
 * Prices are numbers in KZT. To change a price edit the number here; the UI reads everything from this file.
 *
 * The PDF says "Обслуживание 10%" on both pages. Prices here are exactly as printed: the service charge is
 * NOT added to them and it is NOT claimed to be included (the page states the condition next to the prices).
 *
 * `npm run verify:menu` checks this file against scripts/menu-expected.json and the PDF text layer.
 *
 * Architecture note: src/services/menu.ts reads THIS file directly and deliberately bypasses the backend
 * `resolve()` helper, so an API (NEXT_PUBLIC_API_BASE_URL) can never bring an outdated menu back.
 */

/** The 14 headings of the printed menu, in printed order (kitchen first, then the bar). */
export const menuCategories: MenuCategory[] = [
  { id: "main", name: "Вторые блюда" },
  { id: "banquet", name: "Банкетные блюда" },
  { id: "fastfood", name: "Фастфуд" },
  { id: "pizza", name: "Пицца" },
  { id: "sushi", name: "Суши" },
  // Cheap add-ons must not define the "from X ₸" price of the group they sit in.
  { id: "sauces", name: "Соусы", excludeFromMinPrice: true },
  { id: "salads", name: "Салаты" },
  { id: "soups", name: "Супы" },
  { id: "sides", name: "Гарниры" },
  { id: "bread", name: "Хлебные изделия" },
  { id: "tea", name: "Чай" },
  { id: "drinks", name: "Напитки" },
  { id: "milkshakes", name: "Milkshake" },
  { id: "lemonades", name: "Лимонады" },
];

/** What visitors see: 6 groups, order matters. Every printed category is in exactly one group. */
export const menuGroups: MenuGroup[] = [
  { id: "main", name: "Вторые блюда", categoryIds: ["main"] },
  { id: "pizza-fastfood", name: "Пицца, фастфуд и суши", categoryIds: ["fastfood", "pizza", "sushi", "sauces"] },
  { id: "salads-soups", name: "Салаты и супы", categoryIds: ["salads", "soups"] },
  { id: "sides", name: "Хлеб и гарниры", categoryIds: ["bread", "sides"] },
  { id: "drinks", name: "Напитки", categoryIds: ["tea", "drinks", "milkshakes", "lemonades"] },
  { id: "banquet", name: "Банкетное меню", categoryIds: ["banquet"] },
];

type Entry = [id: string, name: string, price: number, image?: string];

/**
 * Item ids: kept from the previous catalog wherever the same dish continues, new ids for new dishes.
 * Photos only where the picture is of exactly this dish.
 */
const rows = (categoryId: string, entries: Entry[]): MenuItem[] =>
  entries.map(([id, name, price, image]) => ({ id, name, price, categoryId, ...(image ? { image } : {}) }));

export const menuItems: MenuItem[] = [
  // ─── КУХНЯ ───
  ...rows("main", [
    ["main-03", "Феттучини с курицей и грибами", 3390, "/menu/pasta-fettuccini-chicken-mushrooms.webp"],
    ["main-05", "Мясо по-тайски", 3490],
    ["main-06", "Курица в соусе терияки", 2890, "/menu/chicken-teriyaki.webp"],
    ["main-12", "Бефстроганов из говядины", 3590],
    ["main-15", "Манты с говядиной (5 шт)", 2790],
    ["main-16", "Манты с тыквой (5 шт)", 2790],
  ]),
  // Banquet portions / weights are not printed on the menu and are intentionally not shown.
  ...rows("banquet", [
    ["banquet-01", "Плов ташкентский", 23790],
    ["banquet-02", "Куырдак", 24790],
    ["banquet-03", "Манты", 13990],
    ["banquet-05", "Фруктовая нарезка", 6790],
  ]),
  ...rows("fastfood", [
    ["fastfood-01", "Чизбургер beef", 3090, "/menu/cheeseburger-beef.webp"],
    ["fastfood-02", "Чизбургер chicken", 2790],
    ["fastfood-03", "Клаб-сэндвич", 2790],
    ["fastfood-04", "Наггетсы", 1790, "/menu/nuggets.webp"],
    ["fastfood-05", "Сырные палочки", 1590],
    ["fastfood-06", "Крылышки 5 шт", 4990],
  ]),
  ...rows("pizza", [
    ["pizza-01", "Маргарита", 2790],
    ["pizza-02", "Пепперони", 3290, "/menu/pizza-pepperoni.webp"],
    ["pizza-04", "4 сыра", 3190],
    ["pizza-05", "4 сезона", 3190],
    ["pizza-06", "С курицей и грибами", 3490, "/menu/pizza-chicken-mushrooms.webp"],
  ]),
  ...rows("sushi", [
    ["sushi-sauces-01", "Жаренные суши с курицей", 3390],
    ["sushi-sauces-02", "Запеченные суши с курицей", 3890],
  ]),
  ...rows("sauces", [
    ["sushi-sauces-04", "Кетчуп", 250],
    ["sushi-sauces-05", "Сырный", 250],
  ]),
  ...rows("salads", [
    ["salads-01", "Салат с хрустящими баклажанами", 2290, "/menu/salad-crispy-eggplant.webp"],
    ["salads-02", "Салат Цезарь с курицей", 2790, "/menu/salad-caesar-chicken.webp"],
    ["salads-03", "Салат греческий", 2790],
    ["salads-04", "Теплый салат с говядиной", 2890],
  ]),
  ...rows("soups", [
    ["soups-02", "Пельмени с говядиной", 1490],
    ["soups-04", "Куриный суп с лапшой", 1590],
  ]),
  ...rows("sides", [
    ["bread-sides-05", "Картофель фри", 990],
    ["bread-sides-06", "Картофельные дольки", 990],
    ["bread-sides-08", "Картофельное пюре", 890],
    ["bread-sides-09", "Рис отварной", 890],
  ]),
  ...rows("bread", [
    ["bread-sides-01", "Хлебная корзина", 1090],
    ["bread-sides-03", "Самса", 2390],
    ["bread-sides-10", "Чебуреки", 2590],
  ]),
  // ─── БАР ───
  ...rows("tea", [
    ["tea-01", "Черный", 990],
    ["tea-02", "Зеленый", 1090],
    ["tea-03", "Чай с молоком", 1090],
    ["tea-04", "Ташкентский", 1390],
    ["tea-05", "Фруктовый", 1390],
    ["tea-06", "Ягодный", 1390],
  ]),
  ...rows("drinks", [
    ["drinks-01", "Fanta/Coca-Cola 0,5 л", 890],
    ["drinks-02", "Fanta/Coca-Cola 1 л", 1190],
    ["drinks-04", "Bonaqua/ASU 0,5 л", 490],
    ["drinks-03", "Bonaqua/ASU 1 л", 690],
    ["drinks-05", "Сок Piko в ассортименте 0,2 л", 690],
    ["drinks-06", "Сок Piko в ассортименте 1 л", 1590],
  ]),
  ...rows("milkshakes", [
    ["milkshakes-07", "Ванильный", 1890],
    ["milkshakes-02", "Клубничный", 1890, "/menu/milkshake-strawberry.webp"],
    ["milkshakes-05", "Шоколадный", 1890],
  ]),
  ...rows("lemonades", [
    ["lemonades-01", "Киви-лайм", 1790],
    ["lemonades-03", "Апельсин-манго", 1790],
    ["lemonades-04", "Лесные ягоды", 1790],
    ["lemonades-05", "Манго-маракуйя", 1790, "/menu/lemonade-mango-passionfruit.webp"],
    ["lemonades-06", "Мохито", 1790],
  ]),
];

export const menuCatalog: MenuCatalog = { categories: menuCategories, groups: menuGroups, items: menuItems };
