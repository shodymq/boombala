#!/usr/bin/env bash
# Checks, from the outside and from the inside, that the admin is invisible to the internet and the database is closed.
#   MODE=outside PUBLIC_IP=203.0.113.10 API_HOST=api.example.org ADMIN_HOST=panel.example.net ./verify-isolation.sh
#       run from a machine that is NOT on the VPN (your laptop on mobile data, another server)
#   MODE=inside  WG_SERVER_ADDR=10.77.0.1 ADMIN_HOST=panel.example.net ./verify-isolation.sh
#       run from a device that IS on the VPN
# Prints PASS / FAIL per check; exit status 1 if any FAIL. It changes nothing and sends no personal data.
# Overridable for tests: CURL_BIN, NC_BIN, DIG_BIN.
set -u
CURL="${CURL_BIN:-curl}"; NC="${NC_BIN:-nc}"; DIG="${DIG_BIN:-dig}"
MODE="${MODE:-}"
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }
status() { "$CURL" -sk -o /dev/null -w '%{http_code}' --max-time 6 "$@" 2>/dev/null || true; }
closed() { ! "$NC" -z -w 3 "$1" "$2" >/dev/null 2>&1; }

need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "set $v" >&2; exit 2; }; done; }

case "$MODE" in
  outside)
    need PUBLIC_IP API_HOST ADMIN_HOST
    for port in 22 5432 3100 3101 3000; do
      closed "$PUBLIC_IP" "$port" && pass "port $port is closed on the public address" || fail "port $port is OPEN on the public address"
    done
    s="$(status "https://$API_HOST/api/health" --resolve "$API_HOST:443:$PUBLIC_IP")"
    [ "$s" = "200" ] && pass "public API health answers (200)" || fail "public API health: $s"
    for p in /login /login/mfa /contacts /requests /bookings /users /audit /export /retention /api/export /api/media/1 /api/cron/outbox; do
      s="$(status "https://$API_HOST$p" --resolve "$API_HOST:443:$PUBLIC_IP")"
      [ "$s" = "404" ] && pass "public API: $p does not exist (404)" || fail "public API: $p answered $s"
    done
    # The admin name, asked on the public address, must not be served: no certificate for it, no content.
    s="$(status "https://$ADMIN_HOST/login" --resolve "$ADMIN_HOST:443:$PUBLIC_IP")"
    case "$s" in 000|404|421|444) pass "the admin name on the public address is not served ($s)";; *) fail "the admin name on the public address answered $s";; esac
    s="$(status "https://$PUBLIC_IP/login" -H "Host: $ADMIN_HOST")"
    case "$s" in 000|404|421|444) pass "the bare public address with the admin Host is not served ($s)";; *) fail "the bare address with the admin Host answered $s";; esac
    if command -v "$DIG" >/dev/null 2>&1; then
      [ -z "$("$DIG" +short "$ADMIN_HOST" 2>/dev/null)" ] && pass "the admin domain has no public DNS record" || fail "the admin domain resolves publicly"
    else
      echo "SKIP  dig not installed: check by hand that the admin domain has no public DNS record"
    fi
    ;;
  inside)
    need WG_SERVER_ADDR ADMIN_HOST
    base=(--resolve "$ADMIN_HOST:443:$WG_SERVER_ADDR")
    s="$(status "https://$ADMIN_HOST/login" "${base[@]}")"; [ "$s" = "200" ] && pass "the login page opens inside the VPN" || fail "login page inside the VPN: $s"
    s="$(status "https://$ADMIN_HOST/api/health" "${base[@]}")"; [ "$s" = "200" ] && pass "health check inside the VPN" || fail "health inside the VPN: $s"
    for p in /api/cron/outbox /api/intake/lead /api/public/news; do
      s="$(status "https://$ADMIN_HOST$p" "${base[@]}")"; [ "$s" = "404" ] && pass "$p is not exposed through the VPN (404)" || fail "$p answered $s through the VPN"
    done
    closed "$WG_SERVER_ADDR" 5432 && pass "PostgreSQL is closed even from the VPN" || fail "PostgreSQL is reachable from the VPN"
    closed "$WG_SERVER_ADDR" 3100 && pass "the application port is closed (only nginx reaches it)" || fail "the application port is reachable from the VPN"
    ;;
  *) echo "set MODE=outside or MODE=inside" >&2; exit 2 ;;
esac
[ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
[ "$fails" -eq 0 ]
