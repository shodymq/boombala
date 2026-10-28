# Round two evidence (Platform 0bd17ac, FastAPI 6245ddc, VPS staging)

- `vps-checks.txt`: headers and CSRF (9/9), smoke (4/4), strict backup restore with per-table manifests (PASSED), negative target checks (production port: exit 5; remote host: exit 5), PostgreSQL readiness, staging listeners.
- `platform/e2e/artifacts/vps-final4/`: staging-host browser and server suites: calendar 29/29, security 8/8, race 9/9, lost-response 15/15 (including the paid-request-before-confirm scenario D).
- Pilot accounts sign in and open the calendar (checked on the host; the credentials are in `~/boombala-staging/pilot-accounts.env` on the host only).
