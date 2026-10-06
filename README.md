# Boom Bala — сайт

Next.js (App Router) + TypeScript + Tailwind CSS v4. Готов к деплою на Vercel.

```bash
npm run dev     # http://localhost:3000
npm run build
```

## Заявки в Telegram

Кнопки «Узнать о свободной дате» / «Забронировать праздник» открывают форму. Она отправляет заявку на
`POST /api/lead`, а сервер пересылает её в Telegram. Переменные **только серверные** (без `NEXT_PUBLIC_`):

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — без них в production форма вернёт 503 (в dev заявка пишется в консоль).
- `TELEGRAM_API_BASE` — необязательно, прокси/мок вместо `https://api.telegram.org`.

Защита: валидация на сервере, honeypot-поле, проверка same-origin, лимит 5 заявок / 10 минут на IP
(in-memory, на serverless работает в пределах одного инстанса; для серьёзной защиты добавьте WAF/Vercel Firewall).

## Аналитика (необязательно)

`NEXT_PUBLIC_GA_ID` (GA4) и `NEXT_PUBLIC_META_PIXEL_ID` (Meta Pixel). Без ID ничего не загружается.
События: ViewPrices, ViewBirthdays, ViewPackage, OpenLeadForm, SubmitLead, ClickRoute, ClickInstagram.

## Что менять, когда появятся данные

Всё в `src/services/config.ts`:

- `opening` — дата и время открытия (сейчас 2026-10-07 12:00, Asia/Almaty). До этого момента идёт обратный отсчёт, после — «BOOM BALA уже открыт».
- `location` — адрес. `NEXT_PUBLIC_MAP_URL` — ссылка для кнопки «Построить маршрут» (пока не задана, кнопка скрыта).
- `contacts.whatsapp` — номер цифрами с кодом страны. Пока `null`: все CTA ведут в Instagram.
- `NEXT_PUBLIC_API_BASE_URL` — адрес общего backend. Пока не задан: данные берутся из `src/data`.

Игровые зоны: заполнить `src/data/attractions.ts` (название, описание, фото).

## Архитектура данных

`UI → src/services/* → src/data/* (сейчас) → REST API (позже)`

Сервисы соответствуют будущим endpoint-ам: `/prices`, `/birthday-packages`, `/promotions`,
`/attractions`, `/events`, `/membership`. Компоненты не знают, откуда пришли данные.
