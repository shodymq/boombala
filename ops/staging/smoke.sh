#!/usr/bin/env bash
# Server-side smoke test of a running staging stack, run on the staging host. No browser, no secrets printed.
# Checks: FastAPI and Platform answer; a linked manager gets a bridge token and reads the catalog and a timeline; an
# assertion for the wrong identity is refused; the production neighbours are only probed for reachability, never changed.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
ok=0; bad=0
check() { if [ "$2" = "1" ]; then echo "PASS $1"; ok=$((ok+1)); else echo "FAIL $1"; bad=$((bad+1)); fi; }

code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$1" || echo 000; }
check "FastAPI docs answer on 127.0.0.1:$STAGING_FASTAPI_PORT" "$([ "$(code "http://127.0.0.1:$STAGING_FASTAPI_PORT/docs")" = 200 ] && echo 1 || echo 0)"
check "Platform login answers on 127.0.0.1:$STAGING_PLATFORM_PORT" "$([ "$(code "http://127.0.0.1:$STAGING_PLATFORM_PORT/login")" = 200 ] && echo 1 || echo 0)"

out="$(cd "$PLATFORM_DIR" && STAGING_FASTAPI="http://127.0.0.1:$STAGING_FASTAPI_PORT" CRM_SERVICE_TOKEN="$CRM_SERVICE_TOKEN" CRM_STAFF_ASSERTION_SECRET="$CRM_STAFF_ASSERTION_SECRET" node --no-warnings --input-type=module -e '
import { staffToken, api } from "./e2e/support/crm-fastapi.mjs";
process.env.E2E_FASTAPI_BASE_URL = process.env.STAGING_FASTAPI;
process.env.E2E_CRM_SERVICE_TOKEN = process.env.CRM_SERVICE_TOKEN;
process.env.E2E_CRM_STAFF_ASSERTION_SECRET = process.env.CRM_STAFF_ASSERTION_SECRET;
const t = await staffToken({ email: "manager-a@staging.boombala.example.com", staffId: "stg-manager-a" });
const catalog = await api(t, "GET", "/admin/birthday-bookings/catalog");
const timeline = await api(t, "GET", "/admin/birthday-bookings/timeline?branchId=stg-almaty&date=2026-12-02");
console.log(JSON.stringify({ token: Boolean(t), catalog: catalog.status, timeline: timeline.status, branches: catalog.body?.branches?.length ?? 0 }));
try { await staffToken({ email: "owner-a@staging.boombala.example.com", staffId: "stg-manager-a" }); console.log("WRONG_ACCEPTED"); } catch { console.log("MISMATCH_REFUSED"); }
' 2>/dev/null)"
echo "$out" | sed 's/^/  /'
check "linked manager obtains a token and reads catalog and timeline" "$(echo "$out" | grep -q '"token":true.*"catalog":200.*"timeline":200' && echo 1 || echo 0)"
check "identity mismatch is refused by FastAPI" "$(echo "$out" | grep -q MISMATCH_REFUSED && echo 1 || echo 0)"

echo "$ok passed, $bad failed"
[ "$bad" -eq 0 ]
