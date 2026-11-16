# Google Sheets «Банкеты» → Boom Bala CRM: dry-run import

Status: **dry run only**. Nothing here writes to production (`bb`), creates bookings or payment facts, or changes any booking API.

## What exists
| Part | File |
|---|---|
| Read-only Sheets API v4 client (service account, scope `spreadsheets.readonly`, GET only) and whole-range reader | `platform/src/core/sheets-import/reader.ts` |
| Header mapping, date/time/phone/room/package/amount normalisation, source key + fingerprint | `normalize.ts` |
| Classification against a read-only CRM snapshot, aggregate summary | `reconcile.ts` |
| Idempotent staging in a separate `sheet_import` schema (not a `bb` migration) | `importer.ts` |
| CLI | `platform/scripts/sheets-import-dry-run.ts` (`npm run sheets:dry-run`) |

Input is either the Sheets API or a local CSV export of the sheet (`--csv file.csv --spreadsheet <id> [--sheet-id <gid>]`); both go through the same normalizer and reconciliation and produce identical source keys, so a later API run updates the same records. Use the real spreadsheet and sheet ids with CSV.

Run:
```
SHEETS_SPREADSHEET_ID=… GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/key.json READ_URL=… [STAGING_URL=…] npm run sheets:dry-run -- [--hours 10:00-23:00] [--report-file local.json]  # or: --csv banquets.csv
```
`READ_URL` is only used inside `BEGIN TRANSACTION READ ONLY`, after a privilege preflight (`checkReadAccess`) that refuses a write-capable, superuser or RLS-blocked role and names any missing column. The CRM snapshot works on both the pre-015 schema (`slot_date` + `slot_id` + `time_slots.starts_at`) and post-015 (exact `starts_at`, minutes kept); the schema is detected from `pg_attribute`. Migration 015 is never applied for this. `STAGING_URL` must be a different, non-production database. Stdout is aggregate counts only; row-level data goes only to the local `--report-file` (mode 600, never commit it).

## Real-sheet formats handled (verified on the owner's CSV export, aggregates only)
Header names «кабинка», «номер», «имя», «имя ребенка», «дет», «взр», «Наименование пакет»; a junk first line is skipped. Dates `dd.mm.yy`/`dd.mm.yyyy`; phones with bidi marks; prepayment `10к`, `10к нал`, `20к перевод …` (→ KZT amount, unverified), `по факту` (= no prepayment); counts `7-8`, `≈15`, `по факту` (→ `count_approximate`, value left empty, never guessed); ages `8 лет`, `3 годик`. Rooms/packages resolve by exact name or alias (Рапунцель→Rapunzel Room, Boom bala party→BOOM PARTY); shared areas (`2 этаж`, `Общий зал`, `Ресторан`), typos and anything with «уточнить»/«согласовать» are not guessed and go to review. The unnamed column with `П` is **not** used as a confirmation flag (its meaning is unconfirmed).

## Semantics (fixed decisions)
- **Time.** The sheet's own time zone is Europe/Moscow, but the cells are typed wall-clock text. They are stored **verbatim as venue wall-clock (Asia/Almaty)**: no conversion, no rounding. 14:30, 16:40, 17:30 stay exactly so. The assumption is recorded on each row (`time_semantics_unconfirmed`) and **must be confirmed by a manager** before the final import.
- **Booking rule (owner decision, supersedes the earlier whole-hour rule):** start = any valid `HH:MM` (13:15, 13:30, 16:40 ...), duration exactly 4 hours, buffer 0 minutes, no overlap in one room, adjacent bookings allowed (an event may start the minute another ends), branch working hours respected. Minutes are never a reason for `NEEDS_REVIEW`; the historical 14:30, 16:40, 17:30 are valid. Overlap is detected per room on `[start, start+4h)`; one minute of overlap is a conflict.
- **Working hours:** checked only when supplied (`--hours 10:00-23:00`, same format as the kernel's `parseWorkingHours`); a 4-hour window that does not fit gives `outside_working_hours`. Without `--hours` the check is skipped and the output says `workingHoursChecked: false`. The real branch hours must be given for the final run.
- **Dependency (not in this PR):** migration 015, `booking-calendar.ts` and the FastAPI kernel still enforce whole-hour starts. Changing that is owned by PR #51/Codex; this importer deliberately touches none of it. The final import cannot write 13:15/16:40 bookings until that kernel change lands.
- **No confirmation flag exists in the sheet.** The strongest status is `CANDIDATE`; never "confirmed".
- **Prepayment** is a manager-typed number: `prepaymentCandidateKzt`, reason `prepayment_unverified`. It never creates a payment fact. Rows with no amount carry `no_prepayment`.
- Statuses: `CANDIDATE`, `NEEDS_REVIEW`, `ALREADY_IN_CRM`, `ARCHIVE_ONLY` (past), blank rows are counted and dropped.
- Identity = hash(spreadsheet, sheet, date, time, room, phone, child); the row number is informational, so moved rows keep their record. Exact duplicates get `#n` and `duplicate_in_sheet`.
- CRM match = same room+start (reservation) or same date+phone+name (lead). Same phone with another name is not a match. Different children/package/room against a match → `matches_crm_conflicting`.

## Single final import and switch-over (plan, needs separate approval)
1. Manager confirms time semantics and the time semantics; the kernel change for any-minute starts is merged and deployed; a backup is taken (pgBackRest + the new R2 backup).
2. Freeze: the Sheet becomes read-only (protect the range) on an announced date; CRM is the only place to add bookings.
3. Final dry run on that frozen sheet; the manager reviews every `NEEDS_REVIEW` row and the `CANDIDATE` list (names redacted in the review UI).
4. One reviewed import through the **existing FastAPI booking writer** (so the PostgreSQL exclusion constraint stays the arbiter): each approved row → booking; payment facts only via the normal payment flow after the manager checks the money.
5. Re-run the dry run: expect 0 inserts and every imported row `ALREADY_IN_CRM`. Keep the Sheet as a read-only archive.
6. Rollback: bookings are released (not deleted) by the existing release flow; staging rows are untouched.

## Owner request (one)
Either send a CSV export (File → Download → CSV) to the machine that runs the dry run, or share the spreadsheet **read-only (Viewer)** with a new service-account e-mail, and put its JSON key into a root-only file on the machine that runs the dry run (not in chat or Git). Also provide `READ_URL` for a temporary column-level read-only role with SELECT-only RLS policies (root/DB-admin prepare + unprivileged run on the VPS, no tunnel, fail-closed cleanup): see [sheets-import-owner-runbook.md](sheets-import-owner-runbook.md). Do not use the broad `bb_backup` role.

## Manager review and approved import (local files, personal data: never in Git)
1. `node --no-warnings platform/scripts/sheets-manager-review.ts export --csv <sheet.csv> --spreadsheet <id> --hours 10:00-23:00 --out review.csv` writes one row per **future** sheet row: date, exact start, end (+240 min), room, package, status, reasons, conflict flag, production match (`NOT_READ` unless a production report was produced), and empty manager columns.
2. The manager fills `manager_decision`: `real` (a real party), `cancel`, `moved` (+ new date/time/room), `unknown`, or `block` (room blocked). For `real`/`moved` the manager also types the **agreed price** and the **verified prepayment** with its method. A sheet value such as `10к` is only displayed as a candidate and is never copied into a payment.
3. `... sheets-manager-review.ts plan --review review.csv --out plan.json` keeps only approved rows that have a price and a verified prepayment (the kernel refuses a confirmation without a recorded prepayment); everything else is counted by reason, not imported.
4. `node platform/scripts/sheets-apply-plan.mjs --plan plan.json --target local|staging|production --fastapi-url … --branch-id … --staff-email … --staff-id …` is a dry run unless `--apply yes`. It writes only through the FastAPI booking endpoints (request → recorded manual prepayment → confirm, or the block endpoint), with an idempotency key derived from the sheet row identity, so a second run reports `already_present` instead of creating a second booking. A room conflict is reported (`conflict_needs_manager`), never forced. `--target production --apply yes` is refused unless the release owner sets `ALLOW_PRODUCTION_APPLY=codex-cutover`.
5. The real kernel today refuses any start that is not on the hour (`invalid_start_time`); such a row is reported as `paid_request_left_unconfirmed_*` (the request and the prepayment already exist and a manager confirms them on another time). Verified on a local FastAPI + PostgreSQL with synthetic rows.
