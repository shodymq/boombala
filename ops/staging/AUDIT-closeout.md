# Closeout audit: CRM calendar on PR #44

Scope: boombala PR #44 (`feat/crm-calendar-ui`) at the commit that adds this file; FastAPI BoomBalaApp `6245ddc`;
the isolated staging on the VPS at Platform `0d9c340`. Synthetic data only.

**Independence caveat.** This audit was written by the same agent that wrote the code. It is a self-audit with evidence, not an
independent review. Before any production decision, have a reviewer who did not write the code repeat items 1–5 below.

## What was checked, and the evidence

| # | Claim | Evidence (in `ops/staging/evidence/closeout-0d9c340/` and `platform/e2e/artifacts/`) | Result |
| --- | --- | --- | --- |
| 1 | Backup restores with the same row counts and checksums | `vps-checks.txt`: manifest of the newest dump (24 requests, 24 payment facts, 23 reservations, 6 admins, 5 platform users) and `restore test PASSED` | PASS |
| 2 | Negative restore tests fail | Local: tampered manifest and corrupted dump both fail the restore test | PASS |
| 3 | No duplicate requests, payments or reservations after a lost response, a reload, or a re-submit with a new key | `vps-final/lost-response` 12/12: response dropped after the server ran; request dropped before it; reload; new key | PASS |
| 4 | Race: a refused confirmation after payment keeps one payment fact | `vps-final/race` 9/9 | PASS |
| 5 | Security headers, clickjacking, CSRF refusal | `vps-checks.txt`: 9/9 (X-Frame-Options DENY, frame-ancestors none, nosniff, referrer, permissions, no unsafe-eval in production, cross-origin POST 403) | PASS |
| 6 | Browser suites on the staging host | `vps-final`: calendar 29/29, security 8/8, race 9/9, lost-response 12/12 | PASS |
| 7 | Isolation from production | `vps-checks.txt`: staging processes use 127.0.0.1:55433 only; listening ports 3400, 8100, 55433 are staging; production listeners (3000, 3100, 3101, 5432, 80, 443) are untouched | PASS |
| 8 | No dual writer when the unified flag is on | Every legacy writer in `src/app/(admin)/bookings/actions.ts` and `requests/actions.ts` returns early when `UNIFIED_FASTAPI_CRM_ENABLED=1`; the calendar writes only through FastAPI | PASS |
| 9 | Restart survives a crash and a logout | Killing FastAPI brings it back within one supervisor cycle (new pid, `fastapi 200`); user unit enabled, linger on | PASS |
| 10 | Tokens never reach a client | `fastapi-crm.ts` and `crm-flows.ts` are `server-only`; grep finds no token in client code | PASS |

## Findings fixed during the closeout

1. `restore-test.sh` hid `pg_restore` errors (`|| true`) and compared only table counts. Now: strict restore (`--exit-on-error`),
   per-table row counts and content checksums, negative tests.
2. The Platform had no explicit reject for cross-origin state changes. Now a 403 is returned before any action runs.
3. A rollback test found that `load_env` overwrote the SHA pair passed by `rollback.sh`. Fixed.
4. The staging checkout disappeared once on the VPS. Cause not established (see below). Now the scripts never delete a checkout,
   refuse to start when a checkout is missing or at the wrong commit, and a supervisor restarts crashed services.

## Open, not fixed (and why)

- **Checkout disappearance root cause.** Not established. No cron job or user timer touches `~/src`; the directory's
  modification time shows its removal at 21:05 VPS time; no command in the logs deletes that path at that moment. Treat it
  as unexplained until the operator reviews the host.
- **Operator role.** There is no Platform role mapped to FastAPI `operator`. Branch scope for operators is not tested.
- **Sales managers cannot block rooms** (FastAPI allows blocks only to `super_admin` and `operator`). The UI shows "Недостаточно прав". This is the correct behaviour, but it is a product decision.
- **Lead status changes are disabled while the unified flag is on** (`requests` page). Managers cannot change lead status in unified mode.
- **Legacy booking writer remains in the code** behind the flag. It is the production path until the flag is switched, which this closeout does not do.
- **HSTS** is set only with `PLATFORM_HTTPS=1`; the staging runs over loopback HTTP. Production TLS and nginx headers were not inspected (production was not touched).
- **Vercel auto-deploy policy** for `main` was not verified. PR #43 and #44 are not merged.
- **Synthetic data only.** No check was made against real client data, real payments or real consent records.

## GO / NO-GO

- **Closed synthetic staging pilot (test accounts, synthetic data, the VPS staging): GO**, on these conditions:
  the human check in `ops/staging/HUMAN-CHECK.md` passes with no P0 finding; the tunnel is opened by the operator on their own
  decision; nobody enters real client data.
- **Production: NO-GO.** Reasons: no independent review; Vercel policy unverified; the operator role is unmapped; no decision on
  switching the unified flag; production nginx/TLS headers not verified; no data-protection review of the synthetic-to-real path.
