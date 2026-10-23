# Передача релиза для сервера в Казахстане (Codex): приложения, переменные, порты, проверки

Это инструкция для того, кто настраивает сервер (Ubuntu 24.04, 2 vCPU, 4 ГБ). Приложения готовы; сервер, PostgreSQL, nginx, WireGuard, systemd, DNS и бэкапы
остаются на стороне инфраструктуры (`deploy/kz/`, `docs/platform/ADMIN-ISOLATION-KZ.md`). Здесь нет ни одного значения секрета: только имена.

## 1. Что получить и как проверить
Архив собирает **GitHub Actions** (`release-artifact`, запуск вручную, Linux x86_64, `ubuntu-24.04`); на VPS и на Mac он не собирается.
Вход: `public_site_url` (https-адрес сайта; вшивается в сборку), `booking_calendar` (`0` до внесения реальных броней), `news` (`0`).
```bash
gh workflow run release-artifact.yml -f public_site_url=https://<ПУБЛИЧНЫЙ_ДОМЕН> -f booking_calendar=0 -f news=0
gh run download <run-id> -D dist && (cd dist && sha256sum -c *.sha256)
```
В архиве `boombala-release/`: `site/`, `platform/`, `src/data/`, `RELEASE.json` (коммит, дата, Node сборки). Распаковать в `/opt/boombala/releases/<commit>/`,
`/opt/boombala/site` и `/opt/boombala/platform` сделать ссылками на `site/` и `platform/` этого каталога (переключение релиза = смена ссылок, откат = возврат ссылок).
Юниты `deploy/kz/systemd/*` запускают `node node_modules/next/dist/bin/next start` внутри этих каталогов: подходит без изменений. `.next/cache` должен быть записываемым
для пользователя сервиса (юниты уже дают `ReadWritePaths`; создайте каталоги заранее).

**Node.js 24 LTS** (нужен и приложениям, и утилитам: `node --no-warnings scripts/*.ts` без компиляции). `npm` на сервере не нужен.

## 2. Процессы и порты (loopback; наружу только nginx)
| Процесс | Каталог | Порт | Роль БД | Роль приложения |
|---|---|---|---|---|
| `bb-site` | `site/` | `SITE_PORT` (3000) | нет БД | публичный сайт |
| `bb-api` | `platform/` | `API_PORT` (3101) | `bb_api` | `PLATFORM_ROLE=api` |
| `bb-admin` | `platform/` | `ADMIN_PORT` (3100) | `bb_admin` | `PLATFORM_ROLE=admin` |
Сайт ходит к API на `http://127.0.0.1:<API_PORT>`; админка слушает только loopback и принимает только адреса VPN (проверяет и nginx, и приложение).

## 3. Переменные окружения (только имена; значения генерируются на сервере, файлы 0600)
Образцы: `deploy/kz/env/{site,api,admin}.env.example`.
- **site.env**: `SITE_PROFILE=kz-production`, `LEAD_PIPELINE=strict`, `PLATFORM_URL`, `PLATFORM_INTAKE_TOKEN`, `REVALIDATE_TOKEN`, `CONSENT_FORM_ENABLED`,
  `LEGAL_OPERATOR_NAME`, `LEGAL_OPERATOR_IIN`, `LEGAL_OPERATOR_REG_ADDRESS` (реквизиты для `/privacy`; владелец передаёт отдельно, в репозиторий не попадают).
  Не должно быть: `DATABASE_URL`, `TELEGRAM_*`, `MFA_ENC_KEY`, `CRON_SECRET`, `PLATFORM_IP_PEPPER`, `ADMIN_ALLOWED_CIDRS` (профиль откажет).
  `NEXT_PUBLIC_*` (`SITE_URL`, `SITE_PROFILE`, `BOOKING_CALENDAR`, `NEWS`) **вшиваются при сборке** (входы workflow), в env-файле сервера они не действуют.
- **api.env**: `PLATFORM_PROFILE=kz-production`, `PLATFORM_ROLE=api`, `PLATFORM_HTTPS=1`, `ALLOWED_HOSTS`, `DATABASE_URL` (роль `bb_api`), `DATABASE_POOL_MAX`,
  `PLATFORM_INTAKE_TOKEN` (тот же, что у сайта), `PLATFORM_IP_PEPPER`, `PII_INTAKE_ENABLED`.
- **admin.env**: `PLATFORM_PROFILE=kz-production`, `PLATFORM_ROLE=admin`, `PLATFORM_HTTPS=1`, `ALLOWED_HOSTS`, `ADMIN_ALLOWED_CIDRS`, `DATABASE_URL` (роль `bb_admin`),
  `DATABASE_POOL_MAX`, `MFA_MODE=required`, `MFA_ENC_KEY`, `CRON_SECRET`, `REVALIDATE_TOKEN`, `SITE_REVALIDATE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_NOTIFY_LEVEL=minimal`.
- **Утилиты** (однократно, из оболочки администратора, не из юнитов): `DATABASE_URL` или `MIGRATION_DATABASE_URL` (владелец `bb_owner`), `BB_API_PASSWORD`, `BB_ADMIN_PASSWORD`, `OWNER_EMAIL`, `BB_PASSWORD`.

## 4. Память 4 ГБ
- Три процесса `next start` без обёртки `npm` (юниты уже так запускают). Замеры (macOS, лёгкая нагрузка, `--max-old-space-size=256`): 130–190 МБ на процесс; обёртка `npm exec` добавила бы ещё ~90 МБ на каждый, поэтому её не использовать.
- Добавить в каждый env-файл: `NODE_OPTIONS=--max-old-space-size=384` (сайт, админка) и `--max-old-space-size=320` (API). Лимиты `MemoryMax` в юнитах (1G / 768M / 1G) остаются защитой сверху.
- Пулы: `DATABASE_POOL_MAX=3` на процесс (итого не больше 6 соединений; `max_connections` PostgreSQL 50 с запасом). Пул сам закрывает «зависшие» соединения; при недоступной БД приложение отвечает 503 и не падает.
- Сборка (`next build`, `npm ci`) на сервере не выполняется вообще.

## 5. Порядок первого запуска (до включения приёма данных)
1. PostgreSQL, роль владельца `bb_owner`, база; **миграции**: `node --no-warnings scripts/migrate.ts` (001…013).
2. **Роли**: `BB_API_PASSWORD=… BB_ADMIN_PASSWORD=… node --no-warnings scripts/db-roles.ts` (повторять после каждой миграции).
3. **Каталог**: `node --no-warnings scripts/seed.ts` (без него все заявки на день рождения отклоняются; без этого шага `preflight` теперь не проходит).
4. **Проверка**: `node --no-warnings scripts/preflight.ts` (миграции и контрольные суммы, функции приёма, роли, каталог). Код выхода ≠ 0 = не запускать приложения.
5. Owner: `BB_PASSWORD=… node --no-warnings scripts/create-user.ts --email <почта> --name "<имя>" --role owner`; при входе Owner включает второй фактор (обязателен).
6. Запустить `bb-api`, `bb-admin`, `bb-outbox.timer`, `bb-site`; затем `deploy/kz/scripts/verify-isolation.sh`.

## 6. Команды, подтверждающие исправность (на сервере)
| Что | Команда | Ожидание |
|---|---|---|
| API | `curl -s -H 'Host: 127.0.0.1:<API_PORT>' http://127.0.0.1:<API_PORT>/api/health` | 200 |
| Админка | `curl -s -H 'Host: <ADMIN_HOST>' -H 'X-Real-IP: <адрес VPN>' http://127.0.0.1:<ADMIN_PORT>/api/health` | 200; с адреса вне VPN: 404 |
| Сайт | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<SITE_PORT>/` и `/privacy` | 200; `/privacy` показывает реквизиты оператора и текст про сервер в Казахстане (RU и KK) |
| Приём закрыт | `POST /api/consent` и `/api/lead` на сайте | 503 до включения (ожидаемо) |
| База недоступна | остановить PostgreSQL на минуту | API `/api/health` 503, сайт `/api/consent` 503 без внутренних подробностей, страницы открываются |
| Журналы | `journalctl -u bb-site -u bb-api -u bb-admin -p warning` | нет `profile_invalid`, нет имён и телефонов |

## 7. Что блокирует запуск (любой пункт = стоп)
- `preflight` вернул ошибки; не выполнен `db:roles` после миграции; каталог не засеян.
- В журнале `site.profile_invalid` или профиль админки/API отвечает 503 (не тот набор переменных, чужой секрет, широкая сеть, нет `https`/`ALLOWED_HOSTS`).
- Сайт хранит `TELEGRAM_*` или `DATABASE_URL`; `LEAD_PIPELINE` не `strict`; `TELEGRAM_NOTIFY_LEVEL` не `minimal`.
- Админка достижима не из VPN; PostgreSQL слушает не loopback; приложение стартует от пользователя с правами на БД владельца.
- `RELEASE.json` показывает платформу не `Linux-x86_64`.
- Документы `visit_rules` и `personal_data_consent` не опубликованы (форма остаётся закрытой: это норма, а не ошибка, пока владелец не утвердит тексты).

## 8. Включение приёма (только после письменного утверждения владельцем текстов и подтверждения, что база и копии в Казахстане)
1. Утверждённые тексты `visit-rules.md` и `personal-data-consent.md` (RU+KK) передать на сервер вне репозитория и выполнить `OWNER_EMAIL=… node --no-warnings scripts/legal-load.ts --dir <папка> --publish`; затем удалить папку (в текстах ИИН и адрес).
2. `LEGAL_OPERATOR_*` в `site.env`; `CONSENT_FORM_ENABLED=1` (`site.env`); `PII_INTAKE_ENABLED=1` (`api.env`); перезапуск `bb-api`, `bb-site`.
3. Одна согласованная синтетическая регистрация с боевого домена (метка «ТЕСТ», без телефона; две отметки): регистрация → `/attendance` через VPN (1 взрослый, +N ожидается) → подтверждение входа → повтор той же отправки не создаёт дубль. Тестовая запись остаётся в БД с меткой; убирается инструментом «Хранение данных».
4. Только после этого DNS-переход и отключение Telegram-пути на старом хостинге.

## 9. Откат
Вернуть ссылки `/opt/boombala/site` и `/opt/boombala/platform` на предыдущий релиз и перезапустить юниты; `CONSENT_FORM_ENABLED=0`, `PII_INTAKE_ENABLED=0` закрывают приём мгновенно (данные остаются в БД); DNS вернуть на прежнюю площадку только по решению владельца (см. `SWITCHOVER-AND-ROLLBACK.md`, режим `rollback-safe`).

## 10. Что проверено в этом выпуске (локально, синтетические данные; не доказательство работы сервера)
Типы и сборки обоих приложений; 274 теста платформы; изоляционный E2E (отдельные процессы API, админки, сайта; профили, MFA, VPN-имитация); `e2e:kz-flow`
(сайт в профиле `kz-production` → API → PostgreSQL → `/attendance`/`/requests` с MFA: регистрация без телефона, две отдельные отметки, точные редакции документов,
1 взрослый / 3 ребёнка / 2 вошли, повтор без дублей, ручной вход без QR, заявка на день рождения в CRM, Telegram без имени и телефона, отказ при отсутствии
опубликованных документов, недоступные API и БД, отсутствие ПДн и секретов в журналах). Не проверено и остаётся за сервером: nginx, TLS, DNS, firewall,
WireGuard, бэкапы и восстановление, реальные нагрузки на 4 ГБ.
