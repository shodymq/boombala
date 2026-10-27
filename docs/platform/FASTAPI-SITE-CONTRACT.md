# Контракт сайта с FastAPI (черновик для согласования с Codex)

**Статус:** черновик. Production-формы сайта по-прежнему ходят в Next.js platform (`PLATFORM_URL`) и Telegram. Этот документ описывает, что FastAPI уже отдаёт, и что нужно решить до переключения.
**Источник контракта:** `BoomBalaApp` `origin/main` (9b65ae5), `backend/app/modules/*/router.py` и `schemas.py`. Все пути ниже относительно префикса `/api/v1`, который задаёт `backend/app/main.py`.
**Клиент:** `src/lib/fastapi/core.ts` (pure, тесты `npm run test:fastapi`), `src/lib/fastapi/index.ts` (server-only).

---

## 1. Что уже есть в FastAPI (проверено по коду)

| Назначение | Метод и путь | Auth | Тело запроса | Ответ |
|---|---|---|---|---|
| Контактная заявка | `POST /mobile/leads/contact` | опционально (Bearer) | `name`, `phone`, `message?`, `email?` | 201 `{id, type, status}` |
| Заявка на праздник | `POST /mobile/leads/birthday` | опционально (Bearer) | `name` 2–120, `phone` (шаблон), **`branchId` обязателен**, `preferredDate?` (≥ сегодня, Asia/Almaty), `guestCount?` 1–60, `comment?`, `packageId?`, `childId?`, `sourceCampaignId?`, `birthdayCycleId?`, `idempotencyKey?` 8–128 | 201 `{requestId, submittedAt, nextStep}` |
| Запрос SMS-кода | `POST /mobile/auth/request-otp` | нет | `phone` 8–20 | 200 `{verification_id, expires_in_seconds, resend_after_seconds}` |
| Проверка SMS-кода | `POST /mobile/auth/verify-otp` | нет | `phone`, `code` (6 цифр), `verification_id` | 200 `{access_token, refresh_token, token_type, expires_in_seconds, refresh_expires_in_seconds, user{id, phone, email}}` |
| Текущий пользователь | `GET /mobile/auth/current-user` | Bearer | — | `{id, phone, email}` |
| Дети | `GET/POST /mobile/me/children`, `PATCH/DELETE /mobile/me/children/{id}` | Bearer | — | — |
| Заявки родителя | `GET /mobile/leads/birthday`, `GET /mobile/leads/birthday/{id}` | Bearer | — | `BirthdayLeadListResponse` / `BirthdayLeadResponse` |
| Обновление токенов | `POST /mobile/auth/refresh` | refresh_token | `refresh_token` | `MobileAuthResponse` |
| Выход | `POST /mobile/auth/logout` | Bearer | — | — |

**Чего в FastAPI НЕТ** (проверено поиском по `backend/app`):
- **Публичного календаря / доступности.** Нет ни одного маршрута с `availability`. Календарь (PR 3) заблокирован до появления эндпоинта и PostgreSQL race tests (N12).
- **Сервисной аутентификации сайт → FastAPI.** Заявки с сайта сейчас анонимны (`optional auth`). Любой может слать POST. Нужен решённый механизм (см. §4).
- **Correlation ID.** Middleware для `X-Request-ID` не найден. Клиент сайта отправляет заголовок, но FastAPI его не возвращает и не пишет в логи.
- **Единого формата ошибок в явном виде.** `core/exceptions/schemas.py` задаёт `{error:{code,message,details}}`, клиент читает `error.code`. Для ошибок валидации FastAPI по умолчанию отдаёт `detail` массивом: это надо подтвердить.

---

## 2. Соответствие полей формы сайта и `BirthdayLeadCreate`

Текущая форма (`src/app/api/lead/route.ts`) отправляет: `name, phone, date, package, room, slot, children, page, referrer, utm_*, idempotencyKey, consent`.

| Поле сайта | Поле FastAPI | Проблема |
|---|---|---|
| `name` | `name` | совпадает (2–120) |
| `phone` | `phone` | шаблон `^\+?[0-9()\- ]{10,20}$`; нормализация +7 на сайте нужна |
| `date` | `preferredDate` | формат ISO `YYYY-MM-DD`; прошедшая дата → 422 |
| `children` | `guestCount` или `comment` | семантика не совпадает: сайт собирает число детей, FastAPI — гостей |
| `package` | `packageId` | сайт передаёт **значение формы** (`wow-party`), FastAPI ждёт ID из `birthday_packages`. Нужна таблица соответствия |
| `room` | — | **нет поля** в `BirthdayLeadCreate` |
| `slot` | — | **нет поля** |
| **филиал** | `branchId` **обязателен** | сайт сейчас не передаёт `branchId` (один филиал). Нужен фиксированный ID главного филиала |
| `idempotencyKey` | `idempotencyKey` | 8–128 символов, сайт генерирует UUID — совместимо |
| `consent` | — | в FastAPI нет поля согласия в заявке; согласие должно храниться отдельно (N13) |
| `utm_*`, `page`, `referrer` | — | нет полей; либо в `comment`, либо отдельная таблица атрибуции |

**Вывод:** контракт `POST /mobile/leads/birthday` **не покрывает** текущую форму без решений по `room/slot`, `branchId` и `packageId`. Переключать production на FastAPI нельзя до этих решений.

---

## 3. Что реализовано в PR 1 (сайт)

- `FASTAPI_FEATURES` — список включённых возможностей: `leads`, `otp`. По умолчанию пусто: клиент не создаётся, сетевых вызовов нет.
- `FASTAPI_BASE_URL` — https или `http://localhost`. Иначе при включённой фиче — `not_configured` (не отправлять ПДн на неверный хост).
- `FASTAPI_TIMEOUT_MS` — по умолчанию 5000, допустимо 500–10000.
- Ошибки: `not_configured | disabled | timeout | unavailable | rejected | invalid_response`. Текст ошибки не содержит URL и не эхует телефон.
- `rejected` несёт только `error.code` FastAPI.
- Ответы 2xx проверяются по контракту (`parse*`). Несоответствие → `invalid_response`.
- Заголовок `x-request-id` (входящий, если валидный; иначе UUID). `redirect: "error"`, `cache: "no-store"`.
- Логи: одна строка `{event, requestId, route (шаблон), status, outcome, durationMs}`. Ни телефона, ни имени, ни токена.
- `redact()` рекурсивно скрывает ключи персональных данных и секретов.
- Тесты: 17 (конфигурация, флаги, отказ по http, disabled без сети, контракт успешных ответов, 4xx/5xx/сеть/таймаут, логи без ПДн, redaction, correlation).

**Не сделано в PR 1 (намеренно):** ни одна страница и ни один route сайта не вызывает клиент. Production-формы не меняются.

---

## 4. Вопросы к Codex (нужны решения до PR 2/3)

1. **Сервисная аутентификация сайта.** Как FastAPI узнаёт, что запрос пришёл с сервера сайта, а не из браузера? Предложение: отдельный секрет `SITE_SERVICE_TOKEN` (только на сервере сайта, не в браузере), заголовок `Authorization` и проверка в dependency. Нужно решение владельца по выпуску и ротации.
2. **Публичный календарь.** Когда появится `GET /api/v1/public/availability?date=|month=` с ответами `free | busy | unavailable` по branch/room/slot без ПДн? Гарантии: fail-closed при ошибке БД, race tests на PostgreSQL.
3. **Соответствие `room/slot/package/branch`.** Какой ID филиала и пакета используется? Нужна таблица соответствия с текущими значениями формы.
4. **Корреляция.** Добавить middleware, который принимает `X-Request-ID` и возвращает его в ответе и в логах FastAPI.
5. **Формат ошибок валидации.** Подтвердить, что все 4xx приходят в `{error:{code,message,details}}`, а не `detail`.
6. **Вход по телефону (N08).** `otp_mock_mode` по умолчанию `True` в `settings.py:23`. Production SMS-провайдер не подключён. Пока не подтверждено — сайт держит вход выключенным (`otp` не включается в production).
7. **Токены.** `verify-otp` отдаёт `access_token` и `refresh_token`. Предложение: сайт хранит их только в серверной сессии (HttpOnly, Secure, SameSite cookie → server-side session), в браузер не возвращает. Подтвердить, что FastAPI не требует CSRF для cookie-сессий, или что будет Bearer через BFF.
8. **Согласие.** Где хранится факт согласия с документами при заявке с сайта (сейчас в `platform`, `consent_events`)? Нужна версия документа в запросе.

---

## 5. Риски production

- Пока `FASTAPI_FEATURES` пуст, риска для текущих форм нет. Риск возникает только при включении флага без решения пунктов 1, 2, 3 и 7.
- При переключении `leads` без соответствия полей (§2) данные заявки будут потеряны или исказятся. Переключение только по shadow-сравнению, не dual write.
- Отключение Next.js platform API — только после проверенной замены каждого flow (N15). В этом PR не трогается.
