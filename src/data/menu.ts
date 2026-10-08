import type { MenuCatalog, MenuCategory, MenuGroup, MenuItem } from "@/types";

/**
 * Cafe menu, transcribed from the printed menu (3 pages). Prices are numbers in KZT.
 * To change a price edit the number here; the UI reads everything from this file.
 *
 * Items listed with "/" (e.g. "Sprite / Fanta / ...") share the single printed price.
 */

export const menuCategories: MenuCategory[] = [
  { id: "main", name: "Основные блюда" },
  { id: "salads", name: "Салаты" },
  { id: "soups", name: "Супы" },
  { id: "bread-sides", name: "Хлеб и гарниры" },
  { id: "banquet", name: "Банкетные блюда" },
  { id: "kids", name: "Детское меню" },
  { id: "fastfood", name: "Фастфуд" },
  { id: "pizza", name: "Пицца" },
  {
    id: "sushi-sauces",
    name: "Суши и соусы",
    subgroups: [
      { id: "sushi", name: "Суши" },
      { id: "sauces", name: "Соусы", excludeFromMinPrice: true },
    ],
  },
  { id: "tea", name: "Чай" },
  { id: "drinks", name: "Напитки" },
  { id: "milkshakes", name: "Милкшейки" },
  { id: "lemonades", name: "Лимонады" },
];

/** What visitors see: 7 groups, order matters. Every original category is in exactly one group. */
export const menuGroups: MenuGroup[] = [
  { id: "kids", name: "Детям", categoryIds: ["kids"] },
  { id: "main", name: "Основное", categoryIds: ["main"] },
  { id: "pizza-fastfood", name: "Пицца и фастфуд", categoryIds: ["pizza", "fastfood", "sushi-sauces"] },
  { id: "salads-soups", name: "Салаты и супы", categoryIds: ["salads", "soups"] },
  { id: "sides", name: "Хлеб и гарниры", categoryIds: ["bread-sides"] },
  { id: "drinks", name: "Напитки", categoryIds: ["tea", "drinks", "milkshakes", "lemonades"] },
  { id: "banquet", name: "Банкетное меню", categoryIds: ["banquet"] },
];

type Entry = [name: string, price: number, extra?: Partial<MenuItem>];

const pad = (n: number) => String(n).padStart(2, "0");

/** id = "<category>-<nn>", stable as long as new items are appended. */
const rows = (categoryId: string, entries: Entry[]): MenuItem[] =>
  entries.map(([name, price, extra], i) => ({ id: `${categoryId}-${pad(i + 1)}`, name, price, categoryId, ...extra }));

const same = (names: string[], price: number): Entry[] => names.map((n) => [n, price]);

export const menuItems: MenuItem[] = [
  ...rows("main", [
    ["Лагман Цомян", 2490],
    ["Курица в кисло-сладком соусе с рисом", 2350],
    ["Феттучини с курицей и грибами", 3390],
    ["Картофельные лодочки с мясом и грибами", 3390],
    ["Мясо по-тайски", 3390],
    ["Курица в соусе терияки", 2790],
    ["Курица в сливочном соусе с рисом", 2790],
    ["Манты домашние", 2490],
    ["Куырдак", 3790],
    ["Шницель с картофельными лодочками", 3390],
    ["Котлеты по-киевски", 3390],
    ["Бефстроганов из говядины", 3390],
    ["Стейк рибай", 5490],
    ["Фри с мясом", 2890],
  ]),
  ...rows("salads", [
    ["Салат с хрустящими баклажанами", 2190],
    ["Цезарь с курицей", 2590],
    ["Греческий салат", 2790],
    ["Тёплый салат с говядиной", 2890],
    ["Салат ачучук", 1590],
    ["Салат свежий", 1590],
    // NEEDS CONFIRMATION: "Стар Кидс" may be a leftover from the previous brand. Printed as-is, not renamed.
    ["Салат «Стар Кидс»", 2150, { needsConfirmation: true }],
  ]),
  ...rows("soups", [
    ["Чечевичный крем-суп", 1390],
    ["Пельмени с говядиной", 1390],
    ["Пельмени с курицей", 1390],
    ["Куриный суп с лапшой", 1390],
  ]),
  ...rows("bread-sides", [
    ["Хлебная корзина", 2090],
    ["Лепёшка", 590],
    ["Самса", 1290],
    ["Бауырсаки с балқаймақом", 1090],
    ["Картофель фри", 890],
    ["Картофельные дольки", 890],
    ["Картофельные лодочки", 890],
    ["Картофельное пюре", 890],
    ["Рис отварной", 890],
  ]),
  // Banquet portions / weights are not printed on the menu and are intentionally not shown.
  ...rows("banquet", [
    ["Плов ташкентский", 22990],
    ["Куырдак", 23990],
    ["Манты", 13990],
    ["Дапанджи", 21990],
    ["Фруктовая нарезка", 6490],
  ]),
  ...rows("kids", [
    ["Сырная паста с сосиской", 1790],
    ["Вареники с картофелем", 1350],
    ["Весёлый клоун", 2890],
    ["Сосиска в кляре", 1390],
    ["Жареная сосиска с пюре «Осьминожка»", 2000],
    ["Блины", 990],
    ["Каша с рисом", 1050],
    ["Каша овсяная", 980],
  ]),
  ...rows("fastfood", [
    ["Чизбургер beef", 2690],
    ["Чизбургер chicken", 2490],
    ["Клаб-сэндвич", 2790],
    ["Наггетсы", 1590],
    ["Сырные палочки", 2590],
    ["Крылышки, 16 шт.", 4990],
    ["Chicken ролл", 2190],
    ["Beef ролл", 2190],
  ]),
  ...rows("pizza", [
    ["Маргарита", 2490],
    ["Пепперони", 2890],
    ["Болоньезе", 3190],
    ["4 сыра", 2990],
    ["4 сезона", 2990],
    ["С курицей и грибами", 3090],
  ]),
  ...rows("sushi-sauces", [
    ["Жареные суши с курицей", 3000, { subgroupId: "sushi" }],
    ["Запечённые суши с курицей", 3500, { subgroupId: "sushi" }],
    ["Тар-тар", 250, { subgroupId: "sauces" }],
    ["Кетчуп", 250, { subgroupId: "sauces" }],
    ["Сырный соус", 250, { subgroupId: "sauces" }],
    ["BBQ", 250, { subgroupId: "sauces" }],
  ]),
  ...rows("tea", [
    ["Чёрный", 990],
    ["Зелёный", 990],
    ["С молоком", 1090],
    ["Ташкентский", 1290],
    ["Фруктовый", 1290],
    ["Ягодный", 1290],
    ["Манго-маракуйя", 1290],
    ["Малина-имбирь", 1290],
  ]),
  ...rows("drinks", [
    ["Sprite / Fanta / Coca-Cola / Fuse Tea, 0,5 л", 890],
    ["Sprite / Fanta / Coca-Cola / Fuse Tea, 1 л", 1190],
    ["BonAqua / ASU, 1 л", 890],
    ["BonAqua / ASU, 0,5 л", 590],
    ["Сок Piko, 0,2 л", 690],
    ["Сок Piko, 1 л", 1490],
    ["Pepsi / Mirinda / 7Up, 1 л", 1190],
    ["Pepsi / Mirinda, разлив 0,5 л", 690],
  ]),
  ...rows(
    "milkshakes",
    same(["Классический", "Клубничный", "Банановый", "Бабл-гам", "Шоколадный", "Сникерс"], 1890),
  ),
  ...rows(
    "lemonades",
    same(["Киви-лайм", "Персик-клубника", "Апельсин-манго", "Лесные ягоды", "Манго-маракуйя", "Мохито"], 1690),
  ),
];

export const menuCatalog: MenuCatalog = { categories: menuCategories, groups: menuGroups, items: menuItems };
