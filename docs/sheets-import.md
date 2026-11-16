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

Run (needs the owner's read-only share, see below):
```
SHEETS_SPREADSHEET_ID=… GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/key.json READ_URL=… [STAGING_URL=…] npm run sheets:dry-run -- [--report-file local.json]
```
`READ_URL` is only used inside `BEGIN TRANSACTION READ ONLY`. `STAGING_URL` must be a different, non-production database. Stdout is aggregate counts only; row-level data goes only to the local `--report-file` (mode 600, never commit it).

## Semantics (fixed decisions)
- **Time.** The sheet's own time zone is Europe/Moscow, but the cells are typed wall-clock text. They are stored **verbatim as venue wall-clock (Asia/Almaty)**: no conversion, no rounding. 14:30, 16:40, 17:30 stay exactly so. The assumption is recorded on each row (`time_semantics_unconfirmed`) and **must be confirmed by a manager** before the final import.
- **Production only allows exact 4-hour intervals on whole hours** (migration 015 trigger and exclusion constraint, not relaxed). Non-whole-hour rows therefore cannot become bookings automatically: `NEEDS_REVIEW` (`time_not_whole_hour`). Options for the manager: move the start, or an explicit product decision to change the rule.
- **No confirmation flag exists in the sheet.** The strongest status is `CANDIDATE`; never "confirmed".
- **Prepayment** is a manager-typed number: `prepaymentCandidateKzt`, reason `prepayment_unverified`. It never creates a payment fact. Rows with no amount carry `no_prepayment`.
- Statuses: `CANDIDATE`, `NEEDS_REVIEW`, `ALREADY_IN_CRM`, `ARCHIVE_ONLY` (past), blank rows are counted and dropped.
- Identity = hash(spreadsheet, sheet, date, time, room, phone, child); the row number is informational, so moved rows keep their record. Exact duplicates get `#n` and `duplicate_in_sheet`.
- CRM match = same room+start (reservation) or same date+phone+name (lead). Same phone with another name is not a match. Different children/package/room against a match → `matches_crm_conflicting`.

## Single final import and switch-over (plan, needs separate approval)
1. Manager confirms time semantics and the answer for non-whole-hour rows; a backup is taken (pgBackRest + the new R2 backup).
2. Freeze: the Sheet becomes read-only (protect the range) on an announced date; CRM is the only place to add bookings.
3. Final dry run on that frozen sheet; the manager reviews every `NEEDS_REVIEW` row and the `CANDIDATE` list (names redacted in the review UI).
4. One reviewed import through the **existing FastAPI booking writer** (so the PostgreSQL exclusion constraint stays the arbiter): each approved row → booking; payment facts only via the normal payment flow after the manager checks the money.
5. Re-run the dry run: expect 0 inserts and every imported row `ALREADY_IN_CRM`. Keep the Sheet as a read-only archive.
6. Rollback: bookings are released (not deleted) by the existing release flow; staging rows are untouched.

## Owner request (one)
Share the spreadsheet **read-only (Viewer)** with a new service-account e-mail, and put its JSON key into a root-only file on the machine that runs the dry run (not in chat or Git). Also provide `READ_URL` with a read-only DB role (as in the backup request, `bb_backup` works).
