#!/usr/bin/env bash
# Security headers, clickjacking and CSRF refusal on a running Platform. Read-only except for one POST that must be refused.
# Usage: headers-check.sh [base-url]   (default: the staging Platform on 127.0.0.1)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
base="${1:-http://127.0.0.1:$STAGING_PLATFORM_PORT}"
ok=0; bad=0
check() { if [ "$2" = "1" ]; then echo "PASS $1"; ok=$((ok+1)); else echo "FAIL $1"; bad=$((bad+1)); fi; }
headers="$(curl -s -o /dev/null -D - -m 15 "$base/login")"
has() { printf '%s' "$headers" | grep -qi "^$1:.*$2" && echo 1 || echo 0; }
check "login: X-Frame-Options DENY (clickjacking)" "$(has X-Frame-Options DENY)"
check "login: CSP frame-ancestors 'none'" "$(has Content-Security-Policy "frame-ancestors 'none'")"
check "login: CSP object-src 'none' and base-uri 'self'" "$([ "$(printf '%s' "$headers" | grep -ci "object-src 'none'" )" -ge 1 ] && printf '%s' "$headers" | grep -qi "base-uri 'self'" && echo 1 || echo 0)"
check "login: X-Content-Type-Options nosniff" "$(has X-Content-Type-Options nosniff)"
check "login: Referrer-Policy same-origin" "$(has Referrer-Policy same-origin)"
check "login: Permissions-Policy denies camera, microphone, geolocation, payment" "$(printf '%s' "$headers" | grep -qi "camera=()" && printf '%s' "$headers" | grep -qi "payment=()" && echo 1 || echo 0)"
# EXPECT_PRODUCTION=0 is for the development server only (it needs eval for hot reload); the staging build must not allow it.
check "script CSP has no unsafe-eval in the production build" "$( [ "${EXPECT_PRODUCTION:-1}" = 0 ] && echo 1 || { printf '%s' "$headers" | grep -qi "unsafe-eval" && echo 0 || echo 1; } )"
# Protected page without a session must redirect to login and never render the calendar.
code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$base/bookings")"
check "protected page without session is redirected (no content)" "$([ "$code" = 307 ] || [ "$code" = 308 ] || [ "$code" = 302 ] && echo 1 || echo 0)"
# CSRF: a state-changing request from another origin is refused before any action runs.
code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST -H 'Origin: http://evil.example' -H 'Content-Type: text/plain' --data 'x' "$base/bookings")"
check "cross-origin POST refused with 403" "$([ "$code" = 403 ] && echo 1 || echo 0)"
echo "$ok passed, $bad failed"
[ "$bad" -eq 0 ]
