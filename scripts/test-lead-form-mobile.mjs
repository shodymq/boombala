/**
 * Browser check of the booking form (lead dialog), the custom package/room pickers and the room gallery sheet.
 * Real Chromium with phone/desktop emulation (viewport, touch, device pixel ratio). It is NOT Safari and NOT a real phone:
 * see docs/mobile-form-manual-checklist.md for what has to be looked at on iOS Safari and Android Chrome.
 *
 *   NEXT_PUBLIC_GA_ID=G-TESTTEST1 TELEGRAM_BOT_TOKEN=000:test TELEGRAM_CHAT_ID=-1 TELEGRAM_API_BASE=http://localhost:4010 npm run dev
 *   npm run test:lead-form        # in another terminal; E2E_CHROME=/path/to/chrome if not at the default macOS location
 *
 * Safety: localhost only; leads are sent to a mock Telegram started here on :4010 and are named "ТЕСТ — НЕ ОБРАБАТЫВАТЬ".
 */
import http from "node:http";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server: " + BASE);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const received = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try { received.push(JSON.parse(body).text ?? ""); } catch {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => mock.listen(4010, r));

const PROFILES = [
  { name: "iPhone 375x812", w: 375, h: 812, mobile: true },
  { name: "iPhone 390x844", w: 390, h: 844, mobile: true },
  { name: "Android 360x800", w: 360, h: 800, mobile: true },
  { name: "Android 412x915", w: 412, h: 915, mobile: true },
  { name: "Small 320x568", w: 320, h: 568, mobile: true },
  { name: "Desktop 1440x900", w: 1440, h: 900, mobile: false },
];

const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (cond, msg) => {
  console.log(cond ? "  ok  " : "  FAIL", msg);
  if (!cond) fails++;
};
// Events end up in window.gtag (stub) or, if the site installed its own gtag, in dataLayer.
const sawEvent = (page, name, key, value) =>
  page.evaluate(([n, k, v]) => [...(window.__ga || []), ...(window.dataLayer || []).map((x) => Array.from(x))].some((a) => a[0] === "event" && a[1] === n && a[2]?.[k] === v), [name, key, value]);
const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

// ── measurements taken inside the page ─────────────────────────────────────────────────────────────────────────
const probe = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.sheet[open]");
    if (!d) return null;
    const panel = d.querySelector(".sheet-panel");
    const r = panel.getBoundingClientRect();
    const area = [...panel.querySelectorAll("div")].find((e) => /overflow-y-auto/.test(e.className));
    const submit = [...panel.querySelectorAll("button")].find((b) => /Отправить заявку|Узнать о бронировании/.test(b.textContent || ""));
    const sr = submit?.getBoundingClientRect();
    const hit = sr ? document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2) : null;
    return {
      left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), bottom: Math.round(r.bottom), innerW: innerWidth, innerH: innerHeight,
      panelOverflowX: panel.scrollWidth > panel.clientWidth + 1, dialogOverflowX: d.scrollWidth > d.clientWidth + 1, docOverflowX: document.documentElement.scrollWidth > innerWidth,
      scrollY: Math.round(scrollY), areaTop: area ? Math.round(area.getBoundingClientRect().top) : null, areaBottom: area ? Math.round(area.getBoundingClientRect().bottom) : null,
      areaScrollable: area ? area.scrollHeight > area.clientHeight + 2 : false, areaScrollTop: area ? area.scrollTop : 0,
      submitTop: sr ? Math.round(sr.top) : null, submitBottom: sr ? Math.round(sr.bottom) : null, submitReachable: !!(hit && submit.contains(hit)),
      selects: d.querySelectorAll("select").length,
    };
  });

for (const prof of PROFILES) {
  console.log(`\n## ${prof.name}`);
  const ctx = await browser.newContext({
    viewport: { width: prof.w, height: prof.h },
    isMobile: prof.mobile,
    hasTouch: prof.mobile,
    deviceScaleFactor: prof.mobile ? 2 : 1,
    locale: "en-US", // an English-language phone: the date must still read in Russian
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("bb-analytics-consent", "granted");
    window.__ga = [];
    window.gtag = (...a) => window.__ga.push(a);
  });
  const page = await ctx.newPage();
  await page.route(/googletagmanager|google-analytics|connect\.facebook/, (r) => r.abort());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const leadRequests = [];
  page.on("request", (r) => r.url().endsWith("/api/lead") && leadRequests.push(r.postDataJSON()));

  await page.goto(BASE + "/birthdays", { waitUntil: "networkidle" });
  await page.evaluate(() => scrollTo({ top: 1400, behavior: "instant" }));
  await page.waitForTimeout(250);
  const pageScrollBefore = await page.evaluate(() => Math.round(scrollY));
  // Playwright's click() scrolls the target into view first; a real tap on a button that is already on screen does not. Click in the page instead.
  const tapOpener = () => page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Узнать о свободной дате/.test(x.textContent || ""));
    b.focus({ preventScroll: true });
    b.click();
  });
  await tapOpener();
  await page.waitForSelector("dialog.sheet[open] form");
  const m0 = await probe(page);

  // geometry
  if (prof.mobile) ok(m0.left === 0 && m0.width === m0.innerW && m0.bottom === m0.innerH, `bottom sheet spans the screen width and sits on the bottom edge (${m0.width}px)`);
  else ok(Math.abs(m0.left + m0.width / 2 - m0.innerW / 2) <= 1 && m0.width <= 512 && m0.top > 0 && m0.bottom < m0.innerH, `centred dialog, ${m0.width}px wide`);
  ok(!m0.panelOverflowX && !m0.dialogOverflowX && !m0.docOverflowX, "no horizontal scroll or overflow");
  ok(m0.selects === 0, "no native <select> in the form");
  ok(m0.submitReachable && m0.submitBottom <= m0.innerH && m0.submitTop >= 0, "the main button is on screen and tappable (nothing covers it)");
  ok(m0.scrollY === pageScrollBefore, "the page behind did not move when the form opened");

  // page behind stays still
  await page.mouse.move(prof.w / 2, 4);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(150);
  ok((await probe(page)).scrollY === pageScrollBefore, "wheel/touch outside the sheet does not scroll the page behind");

  // only the content scrolls
  if (m0.areaScrollable) {
    await page.evaluate(() => {
      const d = document.querySelector("dialog.sheet[open]");
      [...d.querySelectorAll("div")].find((e) => /overflow-y-auto/.test(e.className)).scrollTop = 220;
    });
    const m1 = await probe(page);
    ok(m1.areaScrollTop > 0 && m1.top === m0.top && m1.bottom === m0.bottom && m1.scrollY === pageScrollBefore, "scrolling moves only the content: the sheet and the page stay put");
    ok(m1.submitReachable && m1.submitBottom <= m1.innerH, "the main button stays on screen while the content scrolls");
    await page.evaluate(() => {
      const d = document.querySelector("dialog.sheet[open]");
      [...d.querySelectorAll("div")].find((e) => /overflow-y-auto/.test(e.className)).scrollTop = 0;
    });
  } else ok(true, "content fits without scrolling");

  // stability under validation, expanded lists and browser-chrome changes
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  const mErr = await probe(page);
  ok(mErr.top === m0.top, `validation messages do not move the sheet (top ${m0.top}px -> ${mErr.top}px)`);
  ok(leadRequests.length === 0, "an invalid form is not sent");
  const errTexts = await page.locator("dialog form p.text-\\[\\#b3261e\\]").allInnerTexts();
  ok(errTexts.length >= 4, `errors shown for name, phone, date and consent (${errTexts.length})`);
  ok(await page.evaluate(() => document.activeElement?.getAttribute("name") === "name" || document.activeElement?.id?.endsWith("-name")), "focus moves to the first invalid field");
  ok((await page.locator('dialog [aria-invalid="true"]').count()) >= 3, "invalid fields are marked aria-invalid");
  if (prof.mobile) {
    for (const delta of [90, 180]) {
      await page.setViewportSize({ width: prof.w, height: Math.max(prof.h - delta, 300) });
      const ms = await probe(page);
      ok(ms.top === m0.top && ms.bottom === ms.innerH && ms.submitReachable && ms.submitBottom <= ms.innerH, `browser toolbar / keyboard shrinks the screen by ${delta}px: top stays ${m0.top}px, the main button stays visible`);
    }
    await page.setViewportSize({ width: prof.w, height: prof.h });
  }

  // date shows in Russian, value stays ISO
  const iso = future(60);
  await page.locator('input[type="date"]').fill(iso);
  const dateText = await page.locator("dialog form").getByText(/\d{4}\s*г\./).first().innerText();
  ok(/[а-яё]{3,}/i.test(dateText) && /2\d{3}/.test(dateText), `the date reads in Russian on an English-language browser: "${dateText}"`);
  ok((await page.locator('input[type="date"]').inputValue()) === iso, "the value sent to the API stays YYYY-MM-DD");

  // package picker
  const pkgBtn = page.locator("dialog button[aria-haspopup=listbox]").nth(0);
  await pkgBtn.click();
  const pkgList = page.locator('dialog [role=listbox]');
  ok(await pkgList.isVisible(), "package list opens inline");
  ok((await pkgList.locator("[role=option]").allInnerTexts()).map((t) => t.trim()).join("|") === "WOW PARTY|MAGIC PARTY|BOOM PARTY|Ещё не определились", "package options: WOW, MAGIC, BOOM, undecided");
  ok((await probe(page)).top === m0.top, "opening the list does not move the sheet");
  ok(await page.evaluate(() => document.activeElement?.getAttribute("role") === "listbox"), "focus moves into the list");
  const optHeights = await pkgList.locator("[role=option]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok(optHeights.every((h) => h >= 44), `package cards are at least 44px tall (${optHeights.join(",")})`);
  await pkgList.locator('[role=option][data-value="magic-party"]').click();
  ok((await page.locator('dialog [role=listbox]').count()) === 0, "the list closes after a choice");
  ok((await pkgBtn.innerText()).includes("MAGIC PARTY"), "the field shows the choice");
  ok(await page.evaluate(() => document.activeElement === document.querySelector("dialog button[aria-haspopup=listbox]")), "focus returns to the field");
  ok(await sawEvent(page, "birthday_package_select", "package_id", "magic-party"), "analytics: birthday_package_select fired with the new package");

  // keyboard: arrows, Enter, Escape closes only the list
  await pkgBtn.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  ok((await pkgBtn.innerText()).includes("BOOM PARTY"), "keyboard: Enter opens, ArrowDown moves, Enter chooses");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  ok((await page.locator("dialog.sheet[open]").count()) === 1 && (await page.locator("dialog [role=listbox]").count()) === 0, "Escape inside the list closes only the list, the form stays open");

  // room picker
  const roomBtn = page.locator("dialog button[aria-haspopup=listbox]").nth(1);
  ok((await roomBtn.innerText()).includes("Не выбрана"), "the room field starts as 'Не выбрана'");
  const coverBytes = () => page.evaluate(() => performance.getEntriesByType("resource").filter((r) => /_next\/image/.test(r.name)).reduce((s, r) => s + (r.transferSize || 0), 0));
  const bytesBefore = await coverBytes();
  await roomBtn.click();
  const roomList = page.locator("dialog [role=listbox]");
  ok((await roomList.locator("[role=option]").allInnerTexts()).map((t) => t.trim()).join("|") === "Не выбрана|Roblox Room|Ice Room|Magic Room|Rapunzel Room", "room options: none + 4 rooms");
  await page.waitForFunction(() => [...document.querySelectorAll('dialog [role=listbox] img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 }).catch(() => {});
  ok((await roomList.locator("img").count()) === 4 && (await roomList.locator("img").evaluateAll((is) => is.every((i) => i.naturalWidth > 0))), "four small room covers are shown (existing images)");
  const added = (await coverBytes()) - bytesBefore;
  ok(added < 60_000, `the four covers add only ${Math.round(added / 1024)} KB when the list opens (nothing is preloaded before)`);
  await roomList.locator('[role=option][data-value="rapunzel-room"]').click();
  ok((await roomBtn.innerText()).includes("Rapunzel Room"), "the field shows the chosen room");
  ok(await sawEvent(page, "birthday_room_select", "room_id", "rapunzel-room"), "analytics: birthday_room_select fired");
  ok((await page.locator("dialog").getByText("Это пожелание: выбор не гарантирует").count()) === 1, "the note 'a wish, not a reservation' is kept");

  // touch targets
  const small = await page.evaluate(() => {
    const d = document.querySelector("dialog.sheet[open]");
    return [...d.querySelectorAll("button, input:not([type=hidden]), a.btn, [role=option], a[href]")]
      .filter((e) => e.offsetParent !== null && !e.closest('[aria-hidden="true"]') && !(e.tagName === "A" && e.closest("label")))
      .map((e) => ({ t: (e.getAttribute("aria-label") || e.innerText || e.name || e.tagName).slice(0, 24), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width), type: e.type }))
      .filter((x) => (x.type === "checkbox" ? false : x.h < 44 || x.w < 44));
  });
  ok(small.length === 0, `every control is at least 44x44 px${small.length ? ": " + JSON.stringify(small) : ""}`);

  // valid submission
  await page.locator('input[name="name"]').fill("ТЕСТ — НЕ ОБРАБАТЫВАТЬ");
  const phone = `70712${String(PROFILES.indexOf(prof)).padStart(1, "0")}${String(Math.floor(Math.random() * 90) + 10)}${String(Math.floor(Math.random() * 90) + 10)}`.slice(0, 10).padEnd(10, "0");
  await page.locator('input[name="phone"]').fill(phone);
  await page.locator('input[name="children"]').fill("6");
  await page.locator('input[name="consent"]').check();

  // The server can refuse a field (tampered request, outdated list): the pickers must say so to assistive technology.
  await page.route("**/api/lead", (r) =>
    r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "validation", fieldErrors: { package: "Выберите пакет", room: "Выберите комнату из списка" } }) }),
  );
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await page.locator("dialog [role=combobox][aria-invalid=true]").first().waitFor();
  const a11y = await page.evaluate(() =>
    [...document.querySelectorAll("dialog [role=combobox]")].map((c) => ({
      invalid: c.getAttribute("aria-invalid"),
      described: (c.getAttribute("aria-describedby") || "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() || null),
      name: c.getAttribute("aria-labelledby")?.split(" ").map((id) => document.getElementById(id)?.textContent?.trim()).join(" "),
      expanded: c.getAttribute("aria-expanded"),
    })),
  );
  ok(a11y.length === 2 && a11y.every((x) => x.invalid === "true"), "package and room comboboxes are aria-invalid when the server refuses them");
  ok(a11y[0].described.includes("Выберите пакет") && a11y[1].described.includes("Выберите комнату из списка"), "aria-describedby points to the visible error text");
  ok(a11y.every((x) => x.name && x.expanded === "false"), `each combobox has an accessible name and aria-expanded ("${a11y.map((x) => x.name.slice(0, 22)).join('", "')}")`);
  await page.unroute("**/api/lead");
  await page.locator("dialog button[aria-haspopup=listbox]").nth(0).click();
  await page.locator('dialog [role=option][data-value="boom-party"]').click();
  ok((await page.locator('dialog [role=combobox][aria-invalid=true]').count()) === 1, "changing a field clears only its own error state");
  await page.locator("dialog button[aria-haspopup=listbox]").nth(1).click();
  await page.locator('dialog [role=option][data-value="rapunzel-room"]').click();
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await page.getByText("Заявка отправлена").waitFor({ timeout: 10000 });
  ok(true, "a valid enquiry is accepted");
  const sent = leadRequests.at(-1);
  ok(sent && sent.package === "boom-party" && sent.room === "rapunzel-room" && sent.date === iso && sent.phone.startsWith("+7") && sent.consent === true && sent.children === "6", "the request carries package, room, ISO date, +7 phone and consent");
  await page.waitForTimeout(200);
  ok(received.some((t) => t.includes("BOOM PARTY") && t.includes("Rapunzel Room")), "Telegram (mock) received the lead with package and room");

  // close / focus / scroll restoration / reopen
  await page.getByRole("button", { name: "Закрыть" }).first().click();
  ok((await page.locator("dialog.sheet[open]").count()) === 0, "closes with the button");
  ok(await page.evaluate(() => Math.round(scrollY)) === pageScrollBefore, "the page is exactly where it was");
  ok(await page.evaluate(() => document.activeElement?.textContent?.includes("Узнать о свободной дате")), "focus returns to the button that opened the form");
  await tapOpener();
  await page.waitForSelector("dialog.sheet[open] form");
  ok((await page.locator('input[name="name"]').inputValue()) === "" && (await page.locator("dialog form p.text-\\[\\#b3261e\\]").count()) === 0, "reopened form is clean (no old values or errors)");
  await page.keyboard.press("Escape");
  ok((await page.locator("dialog.sheet[open]").count()) === 0, "Escape closes the form");
  await tapOpener();
  await page.waitForSelector("dialog.sheet[open] form");
  await page.mouse.click(prof.mobile ? prof.w / 2 : 6, prof.mobile ? 8 : 6);
  ok((await page.locator("dialog.sheet[open]").count()) === 0, "a tap on the dimmed backdrop closes the form");
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).overflow !== "hidden"), "page scrolling is released after closing");

  // room gallery sheet (let the scroll restoration of the form that just closed finish first)
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('button[aria-haspopup="dialog"]')?.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(250);
  const gScroll = await page.evaluate(() => Math.round(scrollY));
  await page.locator('button[aria-haspopup="dialog"]').first().click();
  await page.waitForSelector("dialog.sheet[open]");
  const g0 = await probe(page);
  ok(!g0.panelOverflowX && !g0.dialogOverflowX && !g0.docOverflowX, "room gallery: no horizontal overflow");
  if (prof.mobile) ok(g0.left === 0 && g0.width === g0.innerW && g0.bottom === g0.innerH, "room gallery: bottom sheet on the full width");
  ok(g0.scrollY === gScroll && g0.submitReachable && g0.submitBottom <= g0.innerH, "room gallery: page still, 'Узнать о бронировании' on screen");
  if (prof.mobile) {
    await page.setViewportSize({ width: prof.w, height: Math.max(prof.h - 90, 300) });
    const gs = await probe(page);
    ok(gs.top === g0.top && gs.submitReachable && gs.submitBottom <= gs.innerH, "room gallery: a toolbar change does not move the sheet");
    await page.setViewportSize({ width: prof.w, height: prof.h });
  }
  await page.getByRole("button", { name: "Узнать о бронировании" }).click();
  await page.waitForSelector("dialog.sheet[open] form");
  ok((await page.locator("dialog button[aria-haspopup=listbox]").nth(1).innerText()).includes("Room"), "from the gallery the booking form opens with that room already chosen (one modal at a time)");
  ok((await page.locator("dialog.sheet[open]").count()) === 1, "never two sheets at once");

  ok(errors.length === 0, `no JavaScript errors${errors.length ? ": " + errors[0] : ""}`);
  await ctx.close();
}

await browser.close();
mock.close();
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
