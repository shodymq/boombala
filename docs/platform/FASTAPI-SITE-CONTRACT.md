# Контракт сайта и CRM с FastAPI

**Статус на 31 октября 2026:** локальная реализация в ветках `codex/website-lead-api` (`BoomBalaApp`) и `codex/website-lead-crm-inbox` (`boombala`). Изменения не опубликованы и не включены в production. Оба переключателя остаются выключенными.

## Поток заявки с сайта

Next.js route `src/app/api/lead/route.ts` по флагу `UNIFIED_FASTAPI_WEBSITE_LEADS=1` отправляет форму на `POST /api/v1/public/leads/birthday`. По умолчанию форма продолжает использовать текущий путь.

Сайт подписывает точные байты JSON-тела HMAC-SHA256. Подпись связывает метод `POST`, путь `/api/v1/public/leads/birthday`, Unix-время, одноразовый nonce и SHA-256 тела. Заголовки: `X-Service-Id`, `X-Request-Timestamp`, `X-Request-Nonce`, `X-Request-Signature` и обязательный `Idempotency-Key`. Секрет хранится только в серверной среде.

FastAPI сверяет подпись и временное окно, атомарно резервирует nonce в Redis и передаёт заявку существующему `LeadService`. Повтор отправки с тем же `Idempotency-Key` не создаёт вторую заявку; повтор nonce отклоняется. Если Redis или конфигурация подписи недоступны, endpoint отвечает отказом и не переключается на другую базу.

`WebsiteBirthdayLeadCreate` запрещает передавать владение ребёнком, кампанией и беседой. Источник задаёт FastAPI как `website`; `Idempotency-Key` передаётся заголовком, а не в JSON. Согласие передаётся с явным типом документа, версией и методом `web_checkbox`.

Сайт требует явных ID филиала и каталогов через `UNIFIED_FASTAPI_BRANCH_ID`, `UNIFIED_FASTAPI_PACKAGE_MAP`, `UNIFIED_FASTAPI_ROOM_MAP` и `UNIFIED_FASTAPI_SLOT_MAP`. Неизвестное значение формы приводит к отказу до запроса; значения не угадываются.

## Поток CRM-инбокса

При `UNIFIED_FASTAPI_CRM_ENABLED=1` серверная страница `/requests` получает краткоживущий staff-токен через FastAPI bridge и читает заявки из `/api/v1/admin/leads`. FastAPI определяет роль и филиал по своей активной записи пользователя; роль и филиал из утверждения Next.js не принимаются как полномочия. При ошибке CRM страница показывает ошибку и не подменяет данные локальной базой.

В этом режиме страница только читает заявки. Изменение статуса и подтверждение брони отключены до реализации и проверки соответствующих действий через FastAPI. При выключенном флаге сохраняется старый Platform-поток.

Для staff bridge используются `CRM_SERVICE_TOKEN` и отдельный `CRM_STAFF_ASSERTION_SECRET` на обеих сторонах. Оба значения должны совпадать с FastAPI `CRM_SERVICE_TOKEN` и `CRM_STAFF_ASSERTION_SECRET`. Сам staff должен существовать и быть активен в FastAPI. Ограничение источника `CRM_BRIDGE_ALLOWED_IPS` тоже должно соответствовать фактической сетевой топологии.

## Настройки сайта

- `FASTAPI_BASE_URL` — API origin с префиксом `/api/v1`; только HTTPS вне localhost.
- `FASTAPI_FEATURES=leads` — включает общий клиент.
- `UNIFIED_FASTAPI_WEBSITE_LEADS=1` — отдельно включает запись формы сайта.
- `UNIFIED_FASTAPI_WEBSITE_SERVICE_ID` и `UNIFIED_FASTAPI_WEBSITE_SERVICE_SECRET` — сервис и HMAC-ключ сайта.
- `UNIFIED_FASTAPI_BRANCH_ID`, `UNIFIED_FASTAPI_PACKAGE_MAP`, `UNIFIED_FASTAPI_ROOM_MAP`, `UNIFIED_FASTAPI_SLOT_MAP` — явные соответствия ID.
- `UNIFIED_FASTAPI_CONSENT_DOCUMENT_KIND` и `UNIFIED_FASTAPI_CONSENT_DOCUMENT_VERSION` — опубликованный документ согласия.
- `UNIFIED_FASTAPI_CRM_ENABLED=1`, `FASTAPI_ADMIN_BASE_URL`, `CRM_SERVICE_TOKEN`, `CRM_STAFF_ASSERTION_SECRET` — отдельное read-only подключение CRM.

На стороне FastAPI `WEBSITE_LEAD_SERVICE_SECRETS` задаёт JSON-словарь `service_id` → список текущего и предыдущего ключей для ротации; ключи минимум по 32 символа. Также нужны `REDIS_URL` и согласованные CRM bridge secrets. Секреты не добавлять в репозиторий.

## Что ещё требуется до включения

- Подтвердить, что поле сайта «количество детей» можно сохранять как FastAPI `guestCount`, или согласовать отдельное поле.
- Заполнить и сверить production ID филиала, пакетов, комнат и слотов с каталогами обеих систем.
- Сверить тип и версию опубликованного документа согласия и подтвердить допустимость хранения персональных данных в целевой среде.
- Настроить секреты, Redis и сетевое ограничение staff bridge в целевой среде.
- Провести интеграционный прогон в согласованной staging-среде: повторная отправка, чтение заявки из CRM, недоступность FastAPI/Redis и staff без доступа.
- Отдельно реализовать FastAPI-действия для статуса и бронирования, прежде чем включать их в CRM-интерфейсе.

До выполнения этих пунктов флаги остаются `0`, и переключение production не выполняется.
