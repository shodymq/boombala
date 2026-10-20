# PR #5 (мобильная форма) и PR #1–#4: план разрешения конфликтов

Проверено репетицией: ветка `integration/mobile-form-rehearsal` = вершина стека (PR #4) + PR #5 + три мелких правки ниже. Это **не** замена настоящим веткам и **не** для слияния: только доказательство, что план работает.

## Что показала репетиция
- Текстовых конфликтов **нет**: `git merge-tree` для PR #5 против каждой ветки стека (`stage-1`, `supabase-crm`, `bookings`, `news`) отвечает «clean merge». Git аккуратно складывает правки `LeadForm.tsx`, потому что PR #2/#3 правят другие участки (ключ идемпотентности, поле `slot`, вставка `AvailabilityPanel`), а PR #5 — разметку, поля пакета/комнаты/даты и каркас окна.
- Смысловая проверка итоговой формы (`LeadForm.tsx` после слияния): сохранены `idempotencyKey` (создаётся лениво, сбрасывается при любом изменении поля), `slot` (значение по умолчанию `""`, `set("slot", id)`), `AvailabilityPanel` (рендерится внутри прокручиваемой зоны листа перед пакетом), все аналитические события, `rememberPackage/rememberRoom`, WhatsApp-блок, CRM-поток (`LEAD_PIPELINE`).
- Проверки на слитом стеке (платформа + сайт, флаги календаря и новостей включены, `LEAD_PIPELINE=dual`, локальная БД, моки): `npm run test:lead-form` (6 экранов) — зелёный; `platform e2e:booking` (публичный календарь → заявка со слотом → подтверждение → гонка двух менеджеров), `e2e:news`, `e2e` платформы — зелёные; `tsc`, `eslint src scripts` — чисто.

## Три мелкие правки, которые нужны после слияния (смысловые, не конфликты)
| # | Что | Почему | Куда относится |
|---|---|---|---|
| 1 | `AvailabilityPanel`: кнопка «Посмотреть свободные даты» `min-h-11 flex items-center` | высота 20px, тест касаний (≥ 44px) ловит | PR #3 (`feat/platform-bookings`) |
| 2 | `platform/e2e/booking.e2e.mjs`: пакет выбирается через `button[aria-haspopup=listbox]` + `[role=option][data-value=…]` вместо `select[name=package]` | нативного `<select>` больше нет | PR #3 |
| 3 | `platform/e2e/platform.e2e.mjs`: меню редактора ожидается `Обзор, Новости, Мой пароль` | пункт «Новости» добавлен в PR #4, ожидание в тесте не обновили (ошибка PR #4, не связана с PR #5) | PR #4 (`feat/platform-news`) |
Правка `SKIP_TELEGRAM_CHECK` для теста формы уже внутри PR #5.

## Рекомендуемый порядок
Сайт сейчас ломается мобильной формой, поэтому PR #5 идёт первым и независимо.
1. **Проверка PR #5 на iPhone** (Preview, чек-лист `docs/mobile-form-manual-checklist.md`) → ваше разрешение на слияние → `merge` PR #5 в `main` (я не мержу сам).
2. Затем по цепочке, каждый раз `git merge origin/main` (конфликтов нет) и правки из таблицы:
   - `feat/platform-stage-1`: ничего (в ней нет файлов сайта).
   - `feat/platform-supabase-crm` (PR #2): `git merge origin/main`; проверить `npm run test:lead-form` и `test:lead-api`.
   - `feat/platform-bookings` (PR #3): `git merge origin/main` (после #2); применить правки 1 и 2; прогнать `platform npm run e2e:booking` и `test:lead-form` с `NEXT_PUBLIC_BOOKING_CALENDAR=1 SKIP_TELEGRAM_CHECK=1`.
   - `feat/platform-news` (PR #4): `git merge origin/feat/platform-bookings`; правка 3; `e2e:news`, `e2e`.
3. Слияние PR #1 → #2 → #3 → #4 в `main` по очереди (base каждого PR меняется на `main` после слияния предыдущего). Каждый шаг: зелёные тесты, затем ваше разрешение.

## Если нужен другой порядок (стек раньше PR #5)
Тоже без текстовых конфликтов: сначала слить стек, потом PR #5 с `git merge origin/main`; правки 1–3 применяются в тех же ветках до слияния стека. Риск: до слияния PR #5 живой сайт остаётся со старой нестабильной формой.

## Команды для самопроверки после каждого слияния
```bash
git merge-tree --write-tree origin/<ветка стека> origin/fix/mobile-lead-form   # «clean» = нет конфликтов
npx tsc --noEmit && npx eslint src scripts
NEXT_PUBLIC_GA_ID=G-TESTTEST1 npm run dev                                      # + мок Telegram, см. scripts/test-lead-form-mobile.mjs
npm run test:lead-form                                                         # в слитой ветке с календарём: SKIP_TELEGRAM_CHECK=1
```

## Что остаётся риском
Решения, которые принимаются вручную: порядок слияния и момент выкладки; значения `NEXT_PUBLIC_BOOKING_CALENDAR`, `NEXT_PUBLIC_NEWS`, `LEAD_PIPELINE` на production не менять до отдельного решения о размещении данных.
