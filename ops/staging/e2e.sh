#!/usr/bin/env bash
# Runs the three CRM browser/server E2E suites against the staging stack on this host. Test data only.
# Usage: e2e.sh <run-name> <date-prefix>   e.g. e2e.sh run1 2026-12
# Dates are per run: each suite books fixed slots, so every run needs fresh days in the synthetic database.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
run="${1:?usage: e2e.sh <run-name> <date-prefix>}"
prefix="${2:?usage: e2e.sh <run-name> <date-prefix>}"
out="$STAGING_ROOT/artifacts/$run"; mkdir -p "$out"
test_password="${STAGING_TEST_PASSWORD:?set STAGING_TEST_PASSWORD (the one given to seed.sh)}"
export PLATFORM_URL="http://127.0.0.1:$STAGING_PLATFORM_PORT"
export E2E_FASTAPI_BASE_URL="http://127.0.0.1:$STAGING_FASTAPI_PORT"
export FASTAPI_ADMIN_BASE_URL="$E2E_FASTAPI_BASE_URL" UNIFIED_FASTAPI_CRM_ENABLED=1
export E2E_PASSWORD="$test_password"
export E2E_CRM_SERVICE_TOKEN="$CRM_SERVICE_TOKEN" E2E_CRM_STAFF_ASSERTION_SECRET="$CRM_STAFF_ASSERTION_SECRET"
export PLATFORM_DATABASE_URL="postgres://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_PLATFORM_DB"
export FASTAPI_DATABASE_URL="postgresql://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_BACKEND_DB"
export E2E_CHROME="${E2E_CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -1)}"
[ -x "$E2E_CHROME" ] || { echo "no Chromium: run 'npx playwright-core install chromium' in PLATFORM_DIR" >&2; exit 2; }
export E2E_ARTIFACTS="$out"
cd "$PLATFORM_DIR"
status=0
E2E_DATE="$prefix-10" npm run -s e2e:crm-calendar >"$out/calendar.log" 2>&1 || status=1
E2E_SECURITY_DATE="$prefix-11" E2E_ARTIFACTS="$out/security" npm run -s e2e:crm-security >"$out/security.log" 2>&1 || status=1
E2E_RACE_DATE="$prefix-12" E2E_ARTIFACTS="$out/race" npm run -s e2e:crm-race >"$out/race.log" 2>&1 || status=1
for f in calendar security race; do echo "$f: $(tail -1 "$out/$f.log")"; done
echo "artifacts: $out"
exit $status
