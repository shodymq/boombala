# Карта миграции Next.js CRM → FastAPI (Server Actions и SQL)

**Статус:** инвентаризация по `boombala` `origin/main` d5a1617. Next.js CRM остаётся UI сотрудников. Ни один раздел не отключается, пока его сценарий не перенесён и не протестирован.
**Метод:** `platform/src/app/(admin)/*/actions.ts` и `platform/src/core/*.ts` (поиск `bb.*` и вызовов `query`). Полный построчный список SQL приведён по таблицам, не по каждой строке.

## 0. Что уже есть в FastAPI (BoomBalaApp `origin/main` 9b65ae5)
`admin_auth`, `admin_staff`, `admin_leads`, `admin_customers`, `admin_branches`, `admin_birthday_packages`, `admin_news`, `admin_promotions`, `admin_content`, `admin_dashboard`, `admin_push_campaigns`, `admin_reconciliation`, `admin_tickets`, `admin_passes`, `admin_loyalty`.

**Чего в FastAPI нет:** attendance, согласия и юридические документы, слоты/брони праздников (ветка `codex/birthday-booking-v1` не в main), аудит-журнал CRM, MFA сотрудников Next.js (`mfa.ts`).

## 1. Staff authentication и MFA — НЕ переносить до отдельного решения
| Операция | Где | Таблицы |
|---|---|---|
| Вход, проверка пароля, блокировка по попыткам | `login/actions.ts`, `core/auth.ts` | `bb.users`, `bb.login_attempts` |
| MFA: TOTP, код восстановления, сброс сотрудником | `login/mfa/actions.ts`, `core/mfa.ts`, `users/actions.ts resetMfaAction` | `bb.user_mfa`, `bb.mfa_recovery_codes`, `bb.users` |
| Сессии, отзыв | `core/session.ts`, `scripts/revoke-sessions.ts` | `bb.sessions`, `bb.users` |
| Смена своего пароля | `account/actions.ts changeOwnPasswordAction` | `bb.users` |
| Пользователи: создание, роль, активность, пароль, право экспорта | `users/actions.ts` (createUser, changeRole, setActive, resetPassword, setCanExport) | `bb.users` |

**Риск:** FastAPI `admin_auth` и `admin_staff` есть, но MFA и RBAC Next.js (роли `super_admin`, `content_manager`, и т.д. из `core/rbac.ts`) не сравнены. До отдельного утверждённого решения вход и MFA остаются в Next.js. Потеря MFA или RBAC недопустима.

## 2. Заявки (leads) — ПЕРВЫЙ СЛАЙС
| Server Action | Core | SQL (таблицы) | FastAPI аналог |
|---|---|---|---|
| `requests/confirmLeadAction` | `bookings.ts confirmLead` | `bb.lead_requests`, `bb.slot_reservations`, `bb.contacts` | `PATCH /admin/leads/{id}/birthday` (частично) |
| `requests/leadStatusAction` | `bookings.ts setLeadStatus` | `bb.lead_requests` | `PATCH /admin/leads/{id}/status` |
| — (список) | `requests/page.tsx` | `bb.lead_requests`, `bb.contacts` | `GET /admin/leads` |

**Почему первым:** у FastAPI уже есть inbox и смена статуса. Перенос списка и смены статуса даёт проверяемый вертикальный слайс без брони.
**Блокер:** `confirmLead` создаёт бронь (`slot_reservations`). Это часть раздела 3, поэтому в первом слайсе подтверждение брони остаётся в Next.js.

## 3. Брони праздников (bookings) — после решения N12
| Server Action | Core | SQL | FastAPI |
|---|---|---|---|
| `bookings/manualBookingAction` | `bookings.ts createManualBooking` | `bb.slot_reservations`, `bb.contacts`, `bb.packages`, `bb.rooms`, `bb.time_slots` | **нет** |
| `bookings/blockAction` | `bookings.ts createBlock` | `bb.slot_reservations` | **нет** |
| `bookings/releaseAction` | `bookings.ts releaseReservation` | `bb.slot_reservations` | **нет** |
| — (сетка дня) | `bookings.ts getGrid`, `dayAvailability`, `monthAvailability` | `bb.rooms`, `bb.time_slots`, `bb.slot_reservations`, `bb.lead_requests` | только контракт `/public/availability` (не опубликован) |

**Блокер:** нужен один booking kernel. Сравнить `platform/src/core/bookings.ts` + `migrations/006` с `codex/birthday-booking-v1` (миграция `0050`). Нельзя просто объединить таблицы. Нужен PostgreSQL race-тест (N12). Календарь на сайте за флагом: см. `CALENDAR-FASTAPI.md`.

## 4. Клиенты (customers / contacts)
| Server Action | Core | SQL | FastAPI |
|---|---|---|---|
| `contacts/[id]/revokeConsentAction` | `privacy.ts revokeConsent` | `bb.consent_events`, `bb.consent_registrations`, `bb.contacts` | **нет** |
| `contacts/[id]/anonymizeContactAction` | `privacy.ts anonymizeContact` | `bb.contacts`, `bb.lead_requests`, `bb.consent_*`, `bb.slot_reservations` | **нет** |
| — (список и карточка) | `contacts/page.tsx`, `contacts/[id]/page.tsx` | `bb.contacts`, `bb.lead_requests` | `GET /admin/customers` (чтение) |

**Блокер:** модель семьи и контактов (N13): `contacts` сайта и `MobileUser` FastAPI — разные источники. Удаление и анонимизация переносятся только вместе с политикой хранения. Перенос сейчас запрещён.

## 5. Контент (news, promotions, branches, packages, price rules)
| Server Action | Core | SQL | FastAPI |
|---|---|---|---|
| `news/createPostAction`, `savePostAction`, `publishPostAction`, `unpublishPostAction`, `deletePostAction` | `news.ts createPost, updatePost, publishPost, unpublishPost, deletePost` | `bb.news_posts`, `bb.news_images` | `admin_news`, `admin_promotions`, `admin_content` (есть) |
| `news/deleteImageAction` | `news.ts deleteImage` | `bb.news_images` | `admin_news` (проверить) |
| `legal/*` (документы) | `legal.ts createDraft, approveDocument, publishDocument` | `bb.legal_documents` | **нет** |
| каталог: пакеты, комнаты, ценовые правила | `catalog.ts`, `seed.ts` | `bb.packages`, `bb.rooms`, `bb.price_rules`, `bb.time_slots` | `admin_branches`, `admin_birthday_packages` (есть) |

**Важно:** в Next.js нет Server Action для редактирования каталога. Пакеты и цены сейчас задаются seed-скриптом. Поэтому публикация цен из админки пока не работает. Источник каталога (N10) надо решить до переноса. Сайт и `admin_branches` сейчас не совпадают.

**Порядок:** сначала новости и акции (есть в FastAPI), затем каталог после N10, `legal` после N13.

## 6. Согласия (consent)
| Операция | Core | SQL | FastAPI |
|---|---|---|---|
| Регистрация QR-согласия (публичная) | `intake.ts`, `api/intake/consent` | `bb.consent_registrations`, `bb.consent_events`, `bb.legal_documents` | **нет** (`/mobile/leads/*` без согласий) |
| Экспорт данных клиента | `export.ts`, `api/export` | `bb.export_log`, `bb.consent_*`, `bb.contacts` | **нет** |
| Удержание (retention) | `privacy.ts`, `retention/page.tsx` | `bb.retention_settings`, `bb.consent_*` | **нет** |

**Правило:** QR-согласие ≠ визит ≠ оплата (roadmap). Перенос только вместе с версиями документов (N13). Сейчас остаётся в Next.js.

## 7. Посещаемость (attendance) — остаётся в Next.js
| Операция | Core | SQL |
|---|---|---|
| Подтверждение входа (QR) | `attendance.ts confirmRegistrationEntry` | `bb.attendance_entries`, `bb.consent_registrations`, `bb.contacts` |
| Ручная запись, коррекция | `addManualEntry`, `correctEntry` | `bb.attendance_entries`, `bb.attendance_corrections` |
| Поиск, график | `attendance/page.tsx`, `chart.tsx`, `searchAction` | `bb.attendance_*`, `bb.consent_registrations` |

**Причина:** attendance не в V1 cutover как визиты оплаты (см. roadmap §6). В FastAPI модели attendance нет. Перенос отдельным этапом после N13.

## 8. Аудит
| Операция | Core | SQL |
|---|---|---|
| Запись события | `audit.ts` (вызывается из всех actions) | `bb.audit_log` |
| Просмотр журнала | `audit/page.tsx` | `bb.audit_log`, `bb.users` |

**Правило:** при переносе каждого раздела аудит пишется в той же транзакции. Потеря аудита недопустима. Журнал остаётся в Next.js до переноса всех писателей.

## 9. Порядок переноса (один вертикальный слайс за раз)
1. **Заявки: список и смена статуса** → `GET /admin/leads`, `PATCH /admin/leads/{id}/status`. Старый путь работает параллельно, затем переключение с тестом.
2. **Новости и акции** → `admin_news`, `admin_promotions`. Сверка данных, затем переключение публичного чтения.
3. **Каталог (пакеты, комнаты, цены)** — после решения N10 о едином источнике.
4. **Брони праздников** — после решения N12 (booking kernel + race-тест на PostgreSQL).
5. **Клиенты и согласия** — после N13 (модель семьи, версии документов, политика хранения).
6. **Посещаемость** — после N13.
7. **Вход, MFA, RBAC, аудит** — только по отдельному утверждённому решению. Next.js platform API не отключается, пока все его сценарии не мигрированы.

## 10. Что нужно решить до переноса
- Владелец: RBAC-роли FastAPI совпадают с Next.js (`core/rbac.ts`)?
- Владелец: MFA — переносить или оставить в Next.js?
- Codex: booking kernel (`bookings.ts` vs `codex/birthday-booking-v1`).
- Codex: модель `contacts` против `MobileUser` (N13).
- Владелец: источник каталога (N10).
