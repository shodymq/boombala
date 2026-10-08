/**
 * Compares the menu catalog with the venue's list (scripts/menu-expected.json):
 * item count, names, prices, order and group coverage. Run: npm run verify:menu
 */
import { existsSync, readFileSync } from "node:fs";
import { menuCategories, menuGroups, menuItems } from "../src/data/menu.ts";

const expected = JSON.parse(readFileSync(new URL("./menu-expected.json", import.meta.url), "utf8"));
delete expected._note;

const problems = [];
let expectedTotal = 0;

for (const [categoryId, list] of Object.entries(expected)) {
  expectedTotal += list.length;
  const actual = menuItems.filter((i) => i.categoryId === categoryId);
  if (actual.length !== list.length) problems.push(`${categoryId}: expected ${list.length} items, got ${actual.length}`);
  list.forEach(([name, price], i) => {
    const item = actual[i];
    if (!item) return problems.push(`${categoryId}[${i}] missing: ${name}`);
    if (item.name !== name) problems.push(`${categoryId}[${i}] name "${item.name}" != "${name}"`);
    if (item.price !== price) problems.push(`${categoryId}[${i}] "${name}" price ${item.price} != ${price}`);
  });
}

if (menuItems.length !== expectedTotal) problems.push(`total ${menuItems.length} != ${expectedTotal}`);
const ids = new Set(menuItems.map((i) => i.id));
if (ids.size !== menuItems.length) problems.push("duplicate item ids");
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
}
for (const id of Object.keys(expected)) if (!menuCategories.some((c) => c.id === id)) problems.push(`category ${id} missing`);

const flagged = menuItems.filter((i) => i.needsConfirmation).map((i) => `${i.name} (${i.price})`);
console.log(`items: ${menuItems.length} (expected ${expectedTotal}) | categories: ${menuCategories.length} | groups: ${menuGroups.length}`);
console.log(`needs confirmation: ${flagged.length ? flagged.join("; ") : "none"}`);
if (problems.length) {
  console.error("\nFAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("OK: every name and price matches the supplied list.");
