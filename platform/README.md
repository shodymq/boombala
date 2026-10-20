# Boom Bala Platform

Админка и API для сайта boombala.kz: сотрудники и роли, каталог (пакеты, комнаты, слоты, цены), затем заявки,
бронирования, клиентская база (QR) и новости. Отдельное приложение, **не связано** с публичным сайтом в корне
репозитория и с мобильным приложением. Архитектурное решение: [`../docs/platform/ARCHITECTURE.md`](../docs/platform/ARCHITECTURE.md),
эксплуатация и бэкапы: [`../docs/platform/OPERATIONS.md`](../docs/platform/OPERATIONS.md).

Стек: Next.js 16 (App Router), TypeScript, PostgreSQL 16, `pg`, argon2id, zod, Tailwind 4.

## Быстрый старт (локально)

Нужны Node 22.18+ и PostgreSQL 16 (`initdb`, `pg_ctl` в PATH). Приложение запускает **собственный изолированный
кластер** в `platform/.local-pg` на порту 54330 и не трогает другие PostgreSQL на машине.

```bash
cd platform
npm install
npm run db:local -- start                  # приватный PostgreSQL на :54330
export DATABASE_URL=$(npm run -s db:local -- url)
npm run db:migrate                         # схема
npm run db:seed                            # пакеты, комнаты и цены из данных публичного сайта
npm run user:create -- --email you@example.com --name "Имя" --role owner   # пароль вводится скрыто
npm run dev                                # http://localhost:3100
```

## Проверки

```bash
npm run typecheck && npm run lint
npm test            # интеграционные тесты на настоящем PostgreSQL (временный кластер на случайном порту)
npm run build && npm start &
E2E_PASSWORD=... DATABASE_URL=... npm run e2e    # браузерный сценарий (нужны пользователи owner@/manager@/editor@qa.test)
```

`npm test` сам поднимает и удаляет временный кластер, ничего не требуя от окружения.

## CRM, Telegram и выгрузка

Заявки и QR-регистрации сохраняются в PostgreSQL одной транзакцией вместе с задачей уведомления (outbox), Telegram получает
сообщение сразу и с повторами по расписанию. Приём персональных данных выключен (`PII_INTAKE_ENABLED=0`). Подробности и порядок
включения: [`../docs/platform/LEAD-PIPELINE-MIGRATION.md`](../docs/platform/LEAD-PIPELINE-MIGRATION.md). Черновики юридических
текстов: [`../docs/platform/legal/`](../docs/platform/legal/README.md).

Для e2e-сценария CRM нужны `PLATFORM_INTAKE_TOKEN`, `CRON_SECRET` и сервер, запущенный с `PII_INTAKE_ENABLED=1`,
`TELEGRAM_API_BASE=http://127.0.0.1:3199` (заглушка: `node scripts/mock-telegram.mjs 3199`), с тем же токеном и секретом.
Реальный Telegram в тестах не используется.

## Структура

| Путь | Что там |
|---|---|
| `migrations/` | SQL-миграции (применяются один раз, контрольная сумма, транзакция на файл) |
| `src/core/` | Логика без привязки к Next: БД, миграции, пароли, сессии, вход, роли, пользователи, аудит, каталог и цены |
| `src/server/` | Слой доступа для Next (пул, сессия по cookie, проверка прав на сервере) |
| `src/app/` | Страницы и Server Actions админки; `proxy.ts` ставит CSP и защитные заголовки |
| `tests/` | Тесты ядра на реальной PostgreSQL |
| `e2e/` | Браузерный сценарий (вход, роли, подделка действия, чужой origin, выход, блокировка) |

## Правила

- Авторизация проверяется **на сервере** в каждой странице и действии (`requirePermission`). Скрытые кнопки не защита.
- Секреты только в окружении сервера. `.env*` в Git не попадают.
- Миграции в production применяются только после подтверждения владельца.
