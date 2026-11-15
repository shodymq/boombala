# Independent review request: CRM release candidate (PR #50)

Please review as someone who did not write this code. Goal: decide GO/NO-GO for the closed synthetic staging pilot, and say
separately what blocks production. Do not change production, DNS, live services or payments; use the staging only.

## Identity of what to review

- Repository: `shodymq/boombala`, branch `codex/crm-production-release-2026-11-15`, PR #50 (do not merge to `main` without the production deployment gate).
- Commit: the SHA this file was committed with (see `git log -1 -- ops/staging/REVIEW-REQUEST.md`).
- Backend: BoomBalaApp `main` at `6edf03af91e86acae8d5566a092b7745041d6533`, the FastAPI kernel the calendar calls.
- Staging target: VPS `boombala-claude`, Platform `7396c4e21c6576f23d844c1e0f9479f94d158f2f` and backend `6edf03af91e86acae8d5566a092b7745041d6533`, ports 3400 (CRM), 8100 (FastAPI), 55433 (PostgreSQL), all on 127.0.0.1. These SHAs are not evidence that staging has already been deployed.

## What changed in this round (verify each claim)

1. A "booked" success is shown only when the reservation is confirmed AND the request has a real manual prepayment fact AND the
   request is booked (`bookedWithRealPayment` in `src/core/booking-calendar.ts`; tests in `tests/booking-calendar.test.ts`).
2. Before a new request is created, FastAPI is asked for paid, unconfirmed requests with the same phone in the branch
   (`findPaidUnconfirmedRequest` in `src/server/crm-flows.ts`). A match stops the new request and the new payment. Tests in
   `tests/crm-flows.test.ts`; browser scenario D in `e2e/crm-lost-response.e2e.mjs`.
3. Target safety in `ops/staging/*.sh`: `assert_local_port`, `assert_staging_cluster` (compares `show data_directory` with the
   staging data directory), `is_scratch_name` (restore and drop only `*_restore_test`, `*_manifest_tmp`). Negative cases were run
   by hand: port 5432 refused; remote host refused; a root whose cluster is elsewhere refused; live database drop refused.
4. PostgreSQL start is no longer hidden: `pg.sh start` exits non-zero with the log tail; `pg.sh ready` proves a login; `up.sh`
   stops if PostgreSQL does not start.

## Specific questions

- Can any path write a second request or payment fact after a lost response (between payment and confirm)? Trace the actions in
  `src/app/(admin)/bookings/crm-actions.ts`.
- Does any script reach production? Check the environment handling in `lib.sh`, `guard.sh`, `pg.sh`, `backup.sh`,
  `restore-test.sh`, `down.sh`, `up.sh`, `migrate.sh`, `seed.sh`, `pilot-accounts.sh`.
- Is any secret printed, logged or committed? Check `gen-secrets.sh`, `pilot-accounts.sh`, `e2e.sh`, and `ops/staging/evidence/`.
- Is there a dual writer when `UNIFIED_FASTAPI_CRM_ENABLED=1`? The legacy writers in `src/core/bookings.ts` are called from
  `bookings/actions.ts` and `requests/actions.ts`; both have an early return when the flag is on.
- Does the proxy's CSRF rule (`src/proxy.ts`) hold behind nginx, where `x-forwarded-host` is set? Check how it is set in production.

## Historical evidence (not evidence for this release candidate)

- Earlier evidence under `ops/staging/evidence/` and `platform/e2e/artifacts/` is intentionally excluded from this release PR and must not be reused as current proof.
- Run `npm test` in `platform/` and the browser suites below against the exact target SHAs.

## Not in scope

Flutter, WhatsApp, new CRM features, Vercel deployment policy (report what you cannot verify).
