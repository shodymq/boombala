# Vercel: проект `boombala-platform` (только Preview)

Проект не удалось создать из инструментов Claude (ответ 403 на создание проекта). Создаётся вручную в Vercel Dashboard.

| Параметр | Значение |
|---|---|
| Команда | `shodymq's projects` |
| Репозиторий | `shodymq/boombala` |
| Root Directory | `platform` |
| Framework | Next.js |
| Адрес | автоматический `*.vercel.app` (без `admin.boombala.kz`) |
| **Ignored Build Step** | `case "$VERCEL_GIT_COMMIT_REF" in feat/platform-*) exit 1;; *) exit 0;; esac` |
| Vercel Authentication (Deployment Protection) | **Standard / All Deployments** (если тариф позволяет), внутренняя авторизация платформы остаётся обязательной |
| Production | не использовать: `main` не содержит сборки платформы; Ignored Build Step пропускает все ветки, кроме `feat/platform-*` |

Почему Ignored Build Step: Vercel собирает проект при каждом push. Без него `main` (после слияния PR) создал бы production-развёртывание платформы без переменных окружения. Шаг собирает только ветки `feat/platform-*`, это Preview.

Переменные окружения (Environment: **Preview**, тип Sensitive; значения не публиковать):
`DATABASE_URL` (Supabase `boombala-test`, Transaction pooler, порт 6543), `DATABASE_CA_CERT` (PEM, проверка TLS), `PLATFORM_HTTPS=1`, `PII_INTAKE_ENABLED=0`, `PLATFORM_INTAKE_TOKEN`, `CRON_SECRET`, `PLATFORM_IP_PEPPER`.
**Не добавлять** `MIGRATION_DATABASE_URL`, ключи Supabase `anon`/`service_role`, production `TELEGRAM_*`.
Миграции запускаются отдельно из доверенного окружения: `MIGRATION_DATABASE_URL=… npm run db:migrate`.

Проект сайта `boombala`: не менять. Проверить, что `TELEGRAM_*` заданы только для Production, чтобы Preview-сборки сайта не писали в рабочий чат.
