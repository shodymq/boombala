# Календарь праздников: FastAPI availability через адаптер (OFF)

**Статус:** адаптер проверен на реальных ответах FastAPI. Календарь выключен флагом. Включение заблокировано каталогом (CATALOG-001), см. ниже.

## Контракт
Источник: `BoomBalaApp` ветка `codex/public-availability-v1` (PR #11), файлы `backend/app/modules/public_availability/`.
Ответы для тестов сняты с этого кода (`scripts/fixtures/availability/*.json`), а не написаны вручную.

- `GET /api/v1/public/availability?branchId=<id>&date=YYYY-MM-DD`
- `GET /api/v1/public/availability?branchId=<id>&month=YYYY-MM`
- Ровно один из `date` или `month`. Без авторизации, только чтение.
- Ответ: `branchId`, `date|null`, `month|null`, `rooms[{id,name}]`, `slots[{id,code,startsAt,endsAt}]`, `availability[{date,roomId,slotId,status: free|busy}]`, `packages[{id,name,priceKzt|null,priceSource|null}]`.
- Ошибки: `404 branch_not_found`, `422 validation_error` (неверный формат или прошедшая дата), `503 availability_unavailable` (каталог не настроен, ошибка БД). Все в виде `{error:{code,message,details}}`.
- ID на стороне FastAPI — строки (`slot-morning`, `room-main-a`). ID сайта — другие (`1`, `2`, `3`; `ice-room`; `wow-party`). Соответствие задаётся **явной картой** в конфигурации, не в коде.

## Адаптер (`src/lib/availability/adapter.ts`)
Превращает ответ FastAPI в тот же формат, который уже читает `AvailabilityPanel`.

| Ситуация | Что возвращается |
|---|---|
| ячейка `free` | комната в `freeRoomIds` |
| ячейка `busy` | комната не в `freeRoomIds`; если свободных нет — слот «занято» |
| ячейки нет (слот или комната не покрыты) | ошибка `incomplete` → 503. Не «свободно» |
| дубликат ячейки | ошибка `malformed` |
| статус не `free`/`busy` | ошибка `invalid_response` |
| филиал или период не совпадают | ошибка `branch_mismatch` / `period_mismatch` |
| цена есть, `priceSource = catalog_base` | `{amountKzt, source: "base"}` |
| цены нет или пакет не в карте | `null` → на сайте «Стоимость на эту дату уточнит менеджер» |
| `priceSource` неизвестен | ошибка `malformed` |
| лишние поля (клиент, телефон, заметка) | отбрасываются, в выходе не попадают |

**Важно про цену.** `priceKzt` в текущем бэкенде — это `price_from` каталога (базовая «от»-цена), а не цена на конкретную дату. Адаптер показывает её как «стандартная цена». Перед включением владелец должен подтвердить, что это допустимо для показа, или попросить Codex отдать точную цену по правилу.

## Карта каталога (`FASTAPI_CATALOG_MAP`)
JSON, например:
```json
{"branchId":"<id>","rooms":{"ice-room":"<fastapi room id>", "...":"..."},"slots":{"1":"<fastapi slot id>","2":"...","3":"..."},"packages":{"wow-party":"<fastapi package id>","magic-party":"...","boom-party":"..."}}
```
- Каждый ID сайта должен быть в карте (иначе `catalog_map_invalid`, календарь 503).
- Два ID сайта не могут указывать на один ID FastAPI.
- Лишних записей быть не должно.

Сейчас такой карты нет. У сайта 4 комнаты и 3 слота, у бэкенд-фикстуры 2 и 2. **Пока карты нет, календарь честно отвечает 503** (проверено на живом FastAPI).

## Флаги
- `FASTAPI_FEATURES=calendar` — включает FastAPI-источник. Без него всё как раньше (платформа).
- `FASTAPI_BASE_URL` — https или localhost.
- `FASTAPI_CATALOG_MAP` — карта (см. выше).
- `NEXT_PUBLIC_BOOKING_CALENDAR=1` — существующий гейт UI, не меняется.

## Проверено
- Тесты адаптера на реальных ответах: день (свободно/занято, ID сохраняются, без PII, цена), месяц (31 день, счётчики), 503, 404, 422, битый ответ, неполная ячейка, дубликат, филиал и период, неизвестная цена, карта каталога.
- Живой FastAPI (PR #11 код под uvicorn, sqlite с данными тестов): адаптер на живом ответе даёт те же данные; сайт без карты отвечает 503 на день и на месяц.

## Блокеры
1. **CATALOG-001** — реальная карта филиал/пакет/комната/слот из production-каталога.
2. **Цена** — подтвердить показ `price_from` как «стандартная цена» или получить точную цену по правилу.
3. **BOOKING-001** — принять миграцию брони (PR #11 не содержит резерваций для сайта; подтверждённые брони проверяются только в тестах).
4. Публикация в main: PR #11 и `UNIFIED_API_V1.md` (PR #10) пока не в main.

## Порядок включения (после 1–4)
1. Staging: карта каталога, `FASTAPI_FEATURES=calendar`, сравнение с платформой на тех же датах (shadow, без записи).
2. Production: только после совпадения на staging. Решение владельца.
3. Откат: убрать `calendar` из `FASTAPI_FEATURES` — сайт вернётся на платформу.
