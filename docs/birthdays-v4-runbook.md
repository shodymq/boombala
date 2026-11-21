# Pricing V4 — runbook выпуска и отката

Статус: **NO-GO для production** до: согласования тестового получателя Telegram, подтверждения юридических документов в production (read-only), разрешения на deploy. Команды ниже проверены по `platform/package.json` и `platform/scripts/`.

Переменные (значения никогда не печатать и не класть в репозиторий):
- `DATABASE_OWNER_URL` — владелец БД (только для миграций и каталога).
- `BB_API_PASSWORD`, `BB_ADMIN_PASSWORD` — пароли ролей приложения (для `db:roles`).
- Сайт: `LEAD_PIPELINE=telegram-only`. Платформа: `PII_INTAKE_ENABLED=0` (не менять).

## Выпуск

Все команды из каталога `platform/`.

```bash
# 1. Зафиксировать состояние каталога ДО выпуска (цель отката)
DATABASE_URL="$DATABASE_OWNER_URL" npm run catalog:snapshot -- /secure/path/catalog-before-v4.json

# 2. Резервная копия БД (перед любой миграцией)
DATABASE_URL="$DATABASE_OWNER_URL" npm run db:export

# 3. Миграция 017 (маркер; старые пакеты не отключает)
DATABASE_URL="$DATABASE_OWNER_URL" npm run db:migrate

# 4. Роли приложения (после каждой миграции; идемпотентно)
DATABASE_URL="$DATABASE_OWNER_URL" BB_API_PASSWORD="$BB_API_PASSWORD" BB_ADMIN_PASSWORD="$BB_ADMIN_PASSWORD" npm run db:roles
npm run verify:roles

# 5. Каталог V4 (идемпотентно, цены из данных сайта; пакеты создаются активными)
DATABASE_URL="$DATABASE_OWNER_URL" npm run db:seed

# 6. Проверка готовности (старые пакеты ещё могут быть в продаже)
DATABASE_URL="$DATABASE_OWNER_URL" npm run preflight

# 7. Обновить платформу (старый сайт продолжает присылать старые ID — платформа их принимает до шага 9)

# 8. Обновить сайт (LEAD_PIPELINE=telegram-only), smoke-тест 6 комбинаций цен, тест Telegram на согласованном получателе

# 9. Вывести старые пакеты из продажи — ТОЛЬКО после шага 8
DATABASE_URL="$DATABASE_OWNER_URL" npm run catalog:retire-legacy

# 10. Финальная проверка
DATABASE_URL="$DATABASE_OWNER_URL" npm run preflight:final
```

## Откат

Миграции прямые (вперёд): откат кода и флагов, без удаления данных.

```bash
# 1. Вернуть флаги продажи из снимка; V4 уходит из новых продаж, записи сохраняются
DATABASE_URL="$DATABASE_OWNER_URL" npm run catalog:restore -- /secure/path/catalog-before-v4.json --deactivate-current

# 2. Вернуть предыдущую сборку сайта (старый коммит) и пересобрать; LEAD_PIPELINE=telegram-only

# 3. Проверка: старые пакеты в продаже, V4 не в продаже, бронирования V4 на месте
DATABASE_URL="$DATABASE_OWNER_URL" npm run preflight
```

## Что проверено (ветка `release/birthday-packages-v4-integration`)

- Репетиция обновления: БД на уровне production 001–016, старые пакеты в продаже, историческая бронь; затем 017, seed, retire, restore. Тест `platform/tests/catalog-release.test.ts`: 10/10.
- Миграции с нуля 001–017 и seed (повторный запуск не добавляет строк).
- Сайт: WebKit-сценарий `scripts/e2e-webkit/safari-booking.mjs` 15/15 (RU/KZ, выбор пакета, валидация, успех, ошибка, заголовок Telegram).
- Шесть цен (3 пакета × будни/выходные) выводятся на RU и KZ страницах; серверные цены — `platform/tests/pricing-v4.test.ts`.

## Не закрыто

- Согласованный получатель Telegram (реальная доставка).
- Юридические документы production (read-only проверка).
- Роль `bb_api` не имеет доступа к `bb.outbox` (доставка из платформы не работает; не используется при `telegram-only`).
