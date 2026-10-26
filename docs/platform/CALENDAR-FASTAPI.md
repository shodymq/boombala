# Календарь праздников: подключение к FastAPI (contract-driven, OFF)

**Статус:** код готов за флагом, **эндпоинта в FastAPI ещё нет**. Пока его нет, календарь на сайте работает как сейчас через Next.js platform. Ничего не подменяется fixture-данными.

## Что уже есть на сайте (не переписываем)
- `src/components/booking/AvailabilityPanel.tsx` читает только свой `/api/availability`. Он различает три состояния:
  - свободно: слот и комнаты с `freeRoomIds`;
  - занято: `freeRoomIds` пуст, слот недоступен;
  - недоступно: ошибка API. Тогда показывается текст «не удаётся получить», цены и «свободно» не выводятся.
- Текст «Заявка не бронирует время: слот закрепляется после подтверждения менеджером» уже есть.
- Гейт `NEXT_PUBLIC_BOOKING_CALENDAR=1` остаётся как был.

## Что добавлено
- `src/lib/availability/source.ts`: выбор источника.
  - `FASTAPI_FEATURES` без `calendar` → `platform` (текущее поведение, без изменений).
  - `calendar` включён, URL и `FASTAPI_SITE_BRANCH_ID` корректны → `fastapi` для этого филиала.
  - `calendar` включён, но настройка неверна → `unavailable`. Тихого переключения на другой источник нет.
- `src/app/api/availability/route.ts`: выбирает источник. Форма ответа не меняется.
- `src/lib/fastapi/core.ts`: строгие парсеры `parseAvailabilityDay` и `parseAvailabilityMonth`, маршруты с `branch_id`, функции `getAvailabilityDay` и `getAvailabilityMonth`.
- `scripts/availability-core.test.ts`: 12 тестов (`npm run test:calendar`).

## Контракт, который предлагается FastAPI (не опубликован)
`GET /api/v1/public/availability?date=YYYY-MM-DD&branch_id=<id>`
→ `{ date, slots:[{id, startsAt, endsAt, freeRoomIds:[string]}], prices:{ <packageId>: {amountKzt, source: date|weekday|base} | null } }`

`GET /api/v1/public/availability?month=YYYY-MM&branch_id=<id>`
→ `{ month, roomCount, days:{ "YYYY-MM-DD": { "<slotId>": <свободных комнат> } } }`

Правила, которые должен соблюдать FastAPI (они совпадают с платформой):
- Занятым считается только подтверждённая бронь или блок. **Заявка слот не занимает.**
- Дни без записей считаются полностью свободными.
- Цена берётся по пакету на эту дату, с указанием источника.
- В ответе **нет** имён, телефонов, заметок и причин. Сайт всё равно отбрасывает лишние поля.
- При ошибке БД: ошибка, а не «свободно». Этот принцип проверяется тестом на PostgreSQL.

## Как сайт защищается
- Строгие парсеры: отсутствующий `freeRoomIds`, отрицательная цена, неизвестный `source`, свободных комнат больше, чем комнат, → ошибка 503, не «свободно».
- 404 от FastAPI (эндпоинта нет) → ошибка 503. Календарь честно показывает «недоступно».
- `branch_id` проверяется по белому списку символов, поэтому его нельзя использовать для подмены параметров запроса.

## Что требуется от Codex, прежде чем включать
1. Опубликовать эндпоинт с этими формами (или подтвердить другие имена, тогда поправить `core.ts`).
2. Идентификатор филиала и соответствие `branch_id` значениям сайта.
3. Тест race на PostgreSQL: две одновременные брони одной ячейки дают ровно одну подтверждённую.
4. Подтверждение, что `freeRoomIds` строится только из подтверждённых броней и блоков.

## Порядок переключения (после п. 1–4)
1. Staging: `FASTAPI_FEATURES=calendar`, `FASTAPI_SITE_BRANCH_ID`, сравнить ответы platform и FastAPI на одних датах (shadow, без записи).
2. Production с `NEXT_PUBLIC_BOOKING_CALENDAR=1` и без `calendar` до тех пор, пока staging не сойдётся.
3. Включение `calendar` в production отдельным решением владельца.
4. Откат: убрать `calendar` из `FASTAPI_FEATURES`, и сайт вернётся на platform.
