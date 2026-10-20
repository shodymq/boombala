# Vercel: проект `boombala-platform` (только Preview)

## Checklist (короткий)

**Проект**
- [ ] Add New → Project → репозиторий `shodymq/boombala`, **Root Directory = `platform`**, Framework = Next.js, имя `boombala-platform`.
- [ ] Settings → Build & Deployment → **Ignored Build Step** → Custom: `case "$VERCEL_GIT_COMMIT_REF" in feat/platform-*) exit 1;; *) exit 0;; esac`. Настроить сразу после создания: первый автодеплой из `main` в любом случае не соберётся (в `main` ещё нет `platform/`), это безвредно; после слияния PR шаг пропускает `main`.
- [ ] Settings → Deployment Protection → **Vercel Authentication** для Preview (и Production, если доступно). Своя авторизация платформы остаётся обязательной.
- [ ] Settings → Domains: только `*.vercel.app`. Не добавлять `admin.boombala.kz`.
- [ ] Settings → Git: не включать «Production branch» на `main` для сборок (шаг выше их пропускает); не подключать Cron/Integrations.

**Переменные (Settings → Environment Variables → только *Preview*, галочка Sensitive)**
- [ ] `DATABASE_URL` = Supabase `boombala-test` → Connect → **Transaction pooler** (порт 6543). Пароль базы: Project Settings → Database.
- [ ] `DATABASE_CA_CERT` = корневой сертификат Supabase (PEM) из Project Settings → Database → SSL. Без него приложение откажется работать с удалённой базой (проверка TLS обязательна).
- [ ] `PLATFORM_HTTPS=1`, `PII_INTAKE_ENABLED=0`.
- [ ] `PLATFORM_INTAKE_TOKEN`, `CRON_SECRET`, `PLATFORM_IP_PEPPER`: длинные случайные строки (`openssl rand -hex 32`), каждая своя.
- [ ] **НЕ добавлять**: `MIGRATION_DATABASE_URL`, ключи Supabase `anon`/`service_role`, `TELEGRAM_*` рабочего чата.

**Supabase**
- [ ] Project Settings → API → отключить Data API (ключи `anon`/`service_role` не копировать никуда).
- [ ] Миграции только вручную из доверенного окружения (прямое подключение): `MIGRATION_DATABASE_URL=… npm run db:migrate`.

**Сайт `boombala` (не менять, только проверить)**
- [ ] Settings → Environment Variables: у `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` включён **только Production** (Preview и Development выключены).
- [ ] Нет переменных `LEAD_PIPELINE`, `PLATFORM_URL`, `PLATFORM_INTAKE_TOKEN`, `NEXT_PUBLIC_BOOKING_CALENDAR`, `CONSENT_FORM_ENABLED` в Production.

**После подключения** (проверяет Claude, нужен доступ к базе из доверенной среды)
- [ ] `GET <preview-url>/api/health` отвечает `ok` (за Vercel Authentication нужен вход).
- [ ] `VERIFY_REMOTE_CONFIRM=boombala-test DATABASE_URL=<pooler URL> DATABASE_CA_CERT=… npm run verify:remote` в `platform/`: TLS с проверкой сертификата, пулер, схема и RLS, вход и сессия, конкурентное бронирование из независимых соединений. Скрипт использует синтетические данные и удаляет их.

---

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

## Проверка Ignored Build Step
Команда проверена локально для `VERCEL_GIT_COMMIT_REF`: `main`, `fix/main-hotfix`, `feat/other-site-work` и пустое значение → exit 0 (сборка пропускается); `feat/platform-bookings`, `feat/platform-supabase-crm`, `feat/platform-stage-1` → exit 1 (сборка идёт). Vercel: код 0 пропускает сборку, любой другой собирает.
