# Boom Bala — сайт

Next.js (App Router) + TypeScript + Tailwind CSS v4. Готов к деплою на Vercel.

```bash
npm run dev     # http://localhost:3000
npm run build
```

## Что менять, когда появятся данные

Всё в `src/services/config.ts`:

- `opening.time` — точное время открытия (`"HH:mm"`, Asia/Almaty). Пока `null`: на сайте «Открытие — 7 октября».
  Как только время задано, включается обратный отсчёт, а после наступления — «BOOM BALA уже открыт».
- `contacts.whatsapp` — номер цифрами с кодом страны. Пока `null`: все CTA ведут в Instagram.
- `NEXT_PUBLIC_API_BASE_URL` — адрес общего backend. Пока не задан: данные берутся из `src/data`.

Игровые зоны: заполнить `src/data/attractions.ts` (название, описание, фото).

## Архитектура данных

`UI → src/services/* → src/data/* (сейчас) → REST API (позже)`

Сервисы соответствуют будущим endpoint-ам: `/prices`, `/birthday-packages`, `/promotions`,
`/attractions`, `/events`, `/membership`. Компоненты не знают, откуда пришли данные.
