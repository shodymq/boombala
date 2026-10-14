/**
 * Checks the cafe menu catalog (src/data/menu.ts) against the venue's official PDF:
 *  1. scripts/menu-expected.json: an independent transcription (categories, order, names, prices);
 *  2. scripts/menu-pdf-text.txt: the PDF's own text layer, so a typo in BOTH lists cannot slip through;
 *  3. structure: no duplicates, no empty categories or groups, every category in exactly one group,
 *     valid prices and photos, and the "Обслуживание — 10%." note on the page.
 * Run: npm run verify:menu
 */
import { existsSync, readFileSync } from "node:fs";
import { menuCategories, menuGroups, menuItems } from "../src/data/menu.ts";
import { buildMenuView } from "../src/lib/menu.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const expected = JSON.parse(read("./menu-expected.json"));
delete expected._note;
const norm = (s) => s.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
const pdfText = norm(read("./menu-pdf-text.txt"));
const pdfLines = read("./menu-pdf-text.txt").split("\n").map(norm);
const fmt = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;

const problems = [];
const PDF_ITEMS = 58;

// 1. independent list
let expectedTotal = 0;
const expectedIds = Object.keys(expected);
for (const [categoryId, [printedName, list]] of Object.entries(expected)) {
  expectedTotal += list.length;
  const category = menuCategories.find((c) => c.id === categoryId);
  if (!category) { problems.push(`category ${categoryId} missing`); continue; }
  if (category.name !== printedName) problems.push(`${categoryId}: heading "${category.name}" != "${printedName}"`);
  const actual = menuItems.filter((i) => i.categoryId === categoryId);
  if (actual.length !== list.length) problems.push(`${categoryId}: expected ${list.length} items, got ${actual.length}`);
  list.forEach(([name, price], i) => {
    const item = actual[i];
    if (!item) return problems.push(`${categoryId}[${i}] missing: ${name}`);
    if (item.name !== name) problems.push(`${categoryId}[${i}] name "${item.name}" != "${name}"`);
    if (item.price !== price) problems.push(`${categoryId}[${i}] "${name}" price ${item.price} != ${price}`);
  });
}
for (const c of menuCategories) if (!expectedIds.includes(c.id)) problems.push(`extra category in catalog: ${c.id}`);
if (expectedTotal !== PDF_ITEMS) problems.push(`expected list has ${expectedTotal} items, the PDF has ${PDF_ITEMS}`);
if (menuItems.length !== PDF_ITEMS) problems.push(`catalog has ${menuItems.length} items, the PDF has ${PDF_ITEMS}`);

// 2. PDF text layer
const priceTokens = pdfText.match(/\d[\d ]*₸/g) ?? [];
if (priceTokens.length !== PDF_ITEMS) problems.push(`PDF text layer has ${priceTokens.length} prices, expected ${PDF_ITEMS}`);
const unmatchedPdf = [...pdfLines];
let weak = 0;
for (const item of menuItems) {
  const line = `${item.name} ${fmt(item.price)}`;
  const at = unmatchedPdf.indexOf(line);
  if (at >= 0) { unmatchedPdf.splice(at, 1); continue; }
  // Sushi: the PDF text layer prints the two names on one line and the two prices on their own lines.
  weak++;
  const priceLine = unmatchedPdf.indexOf(fmt(item.price));
  if (!pdfText.includes(item.name) || priceLine < 0) problems.push(`${item.id}: "${item.name}" ${fmt(item.price)} not found in the PDF text`);
  else unmatchedPdf.splice(priceLine, 1);
}
const leftoverPrices = unmatchedPdf.filter((l) => /₸/.test(l));
if (leftoverPrices.length) problems.push(`PDF prices not used by any catalog item: ${leftoverPrices.join(" | ")}`);

// 3. structure
const ids = new Set(menuItems.map((i) => i.id));
if (ids.size !== menuItems.length) problems.push("duplicate item ids");
const names = menuItems.map((i) => `${i.categoryId}|${i.name}`);
if (new Set(names).size !== names.length) problems.push("duplicate item (same category and name)");
for (const i of menuItems) {
  if (!Number.isInteger(i.price) || i.price <= 0) problems.push(`${i.id}: bad price ${i.price}`);
  if (!menuCategories.some((c) => c.id === i.categoryId)) problems.push(`${i.id}: unknown category ${i.categoryId}`);
  if (i.image && (!i.image.startsWith("/menu/") || !existsSync(new URL(`../public${i.image}`, import.meta.url)))) {
    problems.push(`${i.id}: image path is not a valid public /menu asset`);
  }
}
const covered = menuGroups.flatMap((g) => g.categoryIds);
for (const c of menuCategories) {
  const n = covered.filter((id) => id === c.id).length;
  if (n !== 1) problems.push(`category ${c.id} appears in ${n} groups (must be exactly 1)`);
  if (!menuItems.some((i) => i.categoryId === c.id)) problems.push(`category ${c.id} is empty`);
}
for (const g of menuGroups) {
  if (!g.categoryIds.length) problems.push(`group ${g.id} has no categories`);
  if (g.categoryIds.some((id) => !menuCategories.some((c) => c.id === id))) problems.push(`group ${g.id} references an unknown category`);
}
if (new Set(menuGroups.map((g) => g.id)).size !== menuGroups.length) problems.push("duplicate group ids (anchors)");
const view = buildMenuView({ categories: menuCategories, groups: menuGroups, items: menuItems });
for (const v of view) {
  if (v.count === 0 || v.blocks.some((b) => b.items.length === 0)) problems.push(`group ${v.group.id} renders an empty block`);
  if (!Number.isFinite(v.minPrice)) problems.push(`group ${v.group.id} has no min price`);
}
if (view.reduce((n, v) => n + v.count, 0) !== PDF_ITEMS) problems.push("the page would not show all 58 items");
const EXPECTED_GROUPS = ["Вторые блюда", "Пицца, фастфуд и суши", "Салаты и супы", "Хлеб и гарниры", "Напитки", "Банкетное меню"];
if (JSON.stringify(menuGroups.map((g) => g.name)) !== JSON.stringify(EXPECTED_GROUPS)) problems.push(`groups are ${JSON.stringify(menuGroups.map((g) => g.name))}`);
const service = read("../src/services/menu.ts");
if (/from\s+["']\.\/http["']|resolve\(/.test(service.replace(/\/\*[\s\S]*?\*\//g, ""))) problems.push("services/menu.ts must read the local catalog only (no API resolve())");
const pageSource = read("../src/app/menu/page.tsx");
if (/детск(ое|ого|ом|ий) меню|Детям/i.test(pageSource)) problems.push("the page still mentions a kids menu");
if (!pageSource.includes("Обслуживание — 10%.")) problems.push('the page lacks the "Обслуживание — 10%." note');

console.log(`items: ${menuItems.length} (PDF ${PDF_ITEMS}) | categories: ${menuCategories.length} | groups: ${menuGroups.length} | exact PDF lines: ${menuItems.length - weak}, split-line matches: ${weak}`);
console.log("groups: " + view.map((v) => `${v.group.id} (${v.count}, от ${v.minPrice} ₸)`).join("; "));
if (problems.length) {
  console.error("\nFAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("OK: all 58 items match the PDF by name, category, order and price; 0 extra, 0 missing, 0 duplicates.");
