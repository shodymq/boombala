// Day-timeline E2E against the local stand-in backend (e2e/support/mock-fastapi-calendar.mjs). Real Platform server, real
// Next server actions, real browser. Synthetic data only. Modes (E2E_MODE): main (default) | apifail | legacy.
//   PLATFORM_URL (default http://127.0.0.1:3100), E2E_PASSWORD, E2E_ARTIFACTS, [E2E_DATE], [E2E_CHROME]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ADMIN = process.env.PLATFORM_URL ?? "http://127.0.0.1:3100";
const PW = process.env.E2E_PASSWORD;
const ART = process.env.E2E_ARTIFACTS;
const DATE = process.env.E2E_DATE ?? "2026-11-16";
const MODE = process.env.E2E_MODE ?? "main";
if (!PW || !ART) throw new Error("E2E_PASSWORD and E2E_ARTIFACTS are required");
mkdirSync(ART, { recursive: true });
const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} [${MODE}] ${name}${detail ? ` — ${detail}` : ""}`);
};
const plain = (t) => t.replace(/[  ]/g, " ");

async function session(email, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const csp = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to apply inline style/i.test(m.text())) csp.push(m.text()); });
  await page.goto(`${ADMIN}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]:has-text("Войти")');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  return { page, csp, context };
}
const open = async (page, q = "") => { await page.goto(`${ADMIN}/bookings?date=${DATE}${q}`); await page.waitForLoadState("networkidle"); };
const shot = (page, name, full = false) => page.screenshot({ path: join(ART, `${name}.png`), fullPage: full });

if (MODE === "apifail") {
  const { page } = await session("owner@test.local");
  await open(page);
  check("API failure shows an explicit error", (await page.locator("main [role=alert]").first().innerText()).includes("Не удалось загрузить календарь"));
  check("API failure draws no grid, so no room looks free", (await page.locator("[data-timeline]").count()) === 0);
  await shot(page, "07-api-error");
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}

const { page, csp } = await session("owner@test.local");
await open(page);
const names = await page.locator("[data-timeline] h2").allInnerTexts();
check("four rooms side by side", names.join("|") === "Roblox Room|Ice Room|Magic Room|Rapunzel Room", names.join("|"));
const cards = page.locator("[data-reservation]");
const attr = async (loc, a) => loc.getAttribute(a);
const byTime = async (room, start) => {
  const col = page.locator(`[data-timeline] [role=group][aria-label="${room}"]`);
  return col.locator(`[data-start="${start}"]`).first();
};
const roblox = await byTime("Roblox Room", "13:00");
const ice = await byTime("Ice Room", "13:30");
const magic = await byTime("Magic Room", "16:40");
const rap1 = await byTime("Rapunzel Room", "10:00");
const rap2 = await byTime("Rapunzel Room", "14:00");
const iceLate = await byTime("Ice Room", "17:30");
const bb = async (l) => l.boundingBox();
const [rb, ib, mb, r1, r2, il] = await Promise.all([bb(roblox), bb(ice), bb(magic), bb(rap1), bb(rap2), bb(iceLate)]);
const pm = rb.height / 240; // pixels per minute, measured
check("13:00-17:00 block is 240 minutes tall", Math.abs(pm * 240 - rb.height) < 0.5 && (await attr(roblox, "data-end")) === "17:00");
check("13:30 starts exactly 30 min below 13:00", Math.abs(ib.y - rb.y - 30 * pm) < 1, `${(ib.y - rb.y).toFixed(1)}px vs ${(30 * pm).toFixed(1)}px`);
check("13:30-17:30 keeps its end between the hour lines", (await attr(ice, "data-end")) === "17:30" && Math.abs(ib.height - 240 * pm) < 1);
check("16:40 starts exactly 220 min below 13:00", Math.abs(mb.y - rb.y - 220 * pm) < 1, `${(mb.y - rb.y).toFixed(1)}px vs ${(220 * pm).toFixed(1)}px`);
check("16:40-20:40 ends at 20:40", (await attr(magic, "data-end")) === "20:40");
check("adjacent bookings touch without overlap (10:00-14:00 | 14:00-18:00)", Math.abs(r1.y + r1.height - r2.y) < 1.5, `gap ${(r2.y - r1.y - r1.height).toFixed(2)}px`);
check("adjacent 13:30-17:30 | 17:30-21:30 touch", Math.abs(ib.y + ib.height - il.y) < 1.5);
check("rooms are independent: 13:00 Roblox and 13:30 Ice coexist", rb.x !== ib.x && (await cards.count()) >= 6);
const counts = await page.locator("[data-summary-counts]").innerText();
check("summary counts come from data", /16 ноября · 4 комнаты · 6 броней · 1 заявка ожидает решения/.test(counts), counts);
const headerSticky = await page.evaluate(() => { const h = document.querySelector("[data-timeline] h2"); return getComputedStyle(h).position; });
check("room headers are sticky", headerSticky === "sticky");
const payTones = await page.locator("[data-reservation]").evaluateAll((els) => els.map((e) => e.getAttribute("data-payment")));
check("payment tone reflects recorded prepayment (unpaid one is marked)", payTones.includes("unpaid") && payTones.includes("prepaid"));
const blockText = await ice.innerText();
check("block text has no full phone number", !/\d{7,}/.test(blockText.replace(/\s/g, "")), plain(blockText.replace(/\n/g, " | ")));
await shot(page, "01-desktop-day");

// card
await ice.click();
await page.waitForSelector("[data-drawer]");
const card = plain(await page.locator("[data-drawer]").innerText());
check("detail card: client, phone, package, room, exact time", card.includes("Вероника Э.") && card.includes("+77010102091") && card.includes("BoomBala Party") && card.includes("Ice Room") && card.includes("13:30–17:30"));
check("detail card: money and remaining", card.includes("130 000") && card.includes("10 000") && card.includes("120 000"));
check("detail card admits what the API does not provide", card.includes("не отдаются API"));
check("card: focus moves into the panel", await page.evaluate(() => document.querySelector("[data-drawer] aside")?.contains(document.activeElement) ?? false));
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector("[data-drawer]"), null, { timeout: 5000 }).catch(() => {});
check("card: Escape closes the panel", (await page.locator("[data-drawer]").count()) === 0);
await ice.click();
await page.waitForSelector("[data-drawer]");
await shot(page, "02-desktop-card");

// create: any minute
await open(page, "&new=1");
await page.waitForSelector("form[aria-label='Новая бронь']");
const form = page.locator("form[aria-label='Новая бронь']");
const endLabel0 = await form.locator("[data-end-time]").innerText();
await form.locator('input[name="startTime"]').fill("17:07");
check("end is derived live (start + 4h)", (await form.locator("[data-end-time]").innerText()).includes("21:07"), endLabel0);
await form.locator('select[name="roomId"]').selectOption({ label: "Roblox Room" });
await form.locator('input[name="customerName"]').fill("Тест Клиент");
await form.locator('input[name="phone"]').fill("+77015550101");
await form.locator('input[name="childName"]').fill("Айя, 7 лет");
await form.locator('input[name="agreedPriceKzt"]').fill("120000");
check("prepayment defaults to 10 000", (await form.locator('input[name="prepaymentKzt"]').inputValue()) === "10000");
await shot(page, "03-desktop-new-booking");
if (MODE === "legacy") {
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((u) => /[?&](ok|error)=/.test(u.search));
  await page.waitForLoadState("networkidle");
  const alert = plain(await page.locator("main [role=alert]").first().innerText());
  check("legacy FastAPI: refusal is shown with the dependency", alert.includes("целый час") && alert.includes("FastAPI"), alert);
  check("legacy FastAPI: the unconfirmed paid request is disclosed, not hidden", (await page.locator("main [role=alert]").nth(1).innerText()).includes("НЕ подтверждена"));
  check("legacy FastAPI: no success shown, no block created", (await page.locator("main [role=status]").count()) === 0 && (await page.locator('[data-start="17:07"]').count()) === 0);
  await shot(page, "08-legacy-refusal");
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
// double click: must create exactly one booking
await form.locator('button[type="submit"]').dblclick();
await page.waitForURL((u) => /[?&]ok=booked/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
const ok = plain(await page.locator("main [role=status]").first().innerText());
check("success is shown only after read-back", ok.includes("Проверено по данным системы"), ok);
const created = page.locator('[data-timeline] [role=group][aria-label="Roblox Room"] [data-start="17:07"]');
check("17:07 booking is at its exact minute, one block only", (await created.count()) === 1 && (await attr(created.first(), "data-end")) === "21:07");
const cb = await bb(created.first());
const rb2 = await bb(roblox);
check("17:07 sits 247 min below 13:00 (no rounding)", Math.abs(cb.y - rb2.y - 247 * pm) < 1, `${(cb.y - rb2.y).toFixed(1)}px vs ${(247 * pm).toFixed(1)}px`);
await shot(page, "04-desktop-after-create");

// conflict
await open(page, "&new=1");
const f2 = page.locator("form[aria-label='Новая бронь']");
await f2.locator('input[name="startTime"]').fill("15:00");
await f2.locator('select[name="roomId"]').selectOption({ label: "Roblox Room" });
await f2.locator('input[name="customerName"]').fill("Конфликт");
await f2.locator('input[name="phone"]').fill("+77015550102");
await f2.locator('input[name="agreedPriceKzt"]').fill("100000");
await f2.locator('button[type="submit"]').click();
await page.waitForURL((u) => /[?&]error=/.test(u.search));
await page.waitForLoadState("networkidle");
const conflict = plain(await page.locator("main [role=alert]").first().innerText());
check("overlap in the same room is refused with a clear message", conflict.includes("Комната занята"), conflict);
check("a refused booking never appears as a success", (await page.locator("main [role=status]").count()) === 0 && (await page.locator('[data-start="15:00"]').count()) === 0);
await shot(page, "05-desktop-conflict");

// reschedule: busy target keeps the original, free target moves
await open(page, `&reservation=${await created.first().getAttribute("data-reservation")}&move=1`);
const mv = page.locator("form[aria-label='Перенос брони']");
await mv.locator('select[name="roomId"]').selectOption({ label: "Rapunzel Room" });
await mv.locator('input[name="startTime"]').fill("17:00");
await mv.locator('button[type="submit"]').click();
await page.waitForURL((u) => /[?&]error=/.test(u.search));
await page.waitForLoadState("networkidle");
check("busy reschedule target is refused", plain(await page.locator("main [role=alert]").first().innerText()).includes("Комната занята"));
check("original booking stays valid after a refused move", (await page.locator('[data-timeline] [role=group][aria-label="Roblox Room"] [data-start="17:07"]').count()) === 1);
const id = await created.first().getAttribute("data-reservation");
await open(page, `&reservation=${id}&move=1`);
const mv2 = page.locator("form[aria-label='Перенос брони']");
await mv2.locator('select[name="roomId"]').selectOption({ label: "Rapunzel Room" });
await mv2.locator('input[name="startTime"]').fill("18:00");
await mv2.locator('button[type="submit"]').click();
await page.waitForURL((u) => /[?&]ok=rescheduled/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
check("reschedule to a free time succeeds and is read back", (await page.locator('[data-timeline] [role=group][aria-label="Rapunzel Room"] [data-start="18:00"]').count()) === 1 && (await page.locator('[data-timeline] [role=group][aria-label="Roblox Room"] [data-start="17:07"]').count()) === 0);

// release
await open(page, `&reservation=${id}`);
await page.locator("[data-drawer] summary").click();
await page.locator("[data-drawer] form button[type=submit]:has-text('Отменить бронь')").click();
await page.waitForURL((u) => /[?&]ok=released/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
check("cancelled booking leaves the grid and is kept in the day history", (await page.locator(`[data-reservation="${id}"]`).count()) === 0 && (await page.locator("ul[aria-label='Снятые брони'] li").count()) === 1);

// date navigation and empty day
await page.locator('a[aria-label="Следующий день"]').click();
await page.waitForURL(/date=2026-11-17/);
await page.waitForLoadState("networkidle");
check("next day: explicit empty state, grid still drawn", (await page.locator("[data-empty]").count()) === 1 && (await page.locator("[data-timeline]").count()) === 1);
check("next day summary counts zero bookings", /17 ноября · 4 комнаты · 0 броней/.test(await page.locator("[data-summary-counts]").innerText()));
await page.locator('a[aria-label="Предыдущий день"]').click();
await page.waitForURL(/date=2026-11-16/);
check("previous day returns", (await page.locator("[data-reservation]").count()) >= 6);

// mobile
const mobile = await session("owner@test.local", { width: 390, height: 844 });
await open(mobile.page);
const mob = await mobile.page.evaluate(() => { const t = document.querySelector("[data-timeline]"); return { scroll: t.scrollWidth, client: t.clientWidth, page: document.documentElement.scrollWidth, win: window.innerWidth }; });
check("mobile: rooms scroll horizontally inside the timeline, the page does not", mob.scroll > mob.client && mob.page <= mob.win + 1, JSON.stringify(mob));
await shot(mobile.page, "06-mobile-day");
await mobile.page.locator("[data-reservation]").first().click();
await mobile.page.waitForSelector("[data-drawer]");
await shot(mobile.page, "06b-mobile-card");
check("no CSP violations in the browser", csp.length === 0 && mobile.csp.length === 0, [...csp, ...mobile.csp].join(" ; "));

// roles
const op = await session("operator@test.local");
await open(op.page);
const opText = plain(await op.page.locator("[data-timeline]").innerText());
check("operator role: client names are hidden in the grid", opText.includes("Клиент скрыт") && !opText.includes("Вероника"));
await op.page.locator("[data-reservation]").first().click();
await op.page.waitForSelector("[data-drawer]");
const opCard = plain(await op.page.locator("[data-drawer]").innerText());
check("operator role: no phone in the card", !/\+7\d{7,}/.test(opCard.replace(/\s/g, "")) && opCard.includes("Скрыто для вашей роли"));
const ed = await session("editor@test.local");
const resp = await ed.page.goto(`${ADMIN}/bookings?date=${DATE}`);
const edText = plain(await ed.page.locator("body").innerText());
check("editor role cannot open the calendar", !edText.includes("Roblox Room"), `${resp?.status()} ${ed.page.url()}`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
