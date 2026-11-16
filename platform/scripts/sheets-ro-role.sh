#!/usr/bin/env bash
# Temporary read-only PostgreSQL role for the Google Sheets reconciliation.
#   create : creates bb_sheets_ro (expires automatically), grants column-level SELECT, writes the connection URL to a
#            mode-600 file. The password is generated here, goes to psql through stdin only, and is never printed.
#   revoke : terminates its sessions, drops the role and its grants, shreds the URL file.
#   status : shows whether the role exists and when it expires (no secrets).
# Never applies a migration, never writes to bb.*.
#
# Env (all optional):
#   PSQL_ADMIN   admin psql command, default: sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d boombala
#   TTL_HOURS    role lifetime, default 48
#   TUNNEL_PORT  local port the owner's SSH tunnel will use in the URL, default 55432
#   DB_NAME      database name inside the URL, default boombala
#   URL_FILE     where the URL is written, default $HOME/.bb_sheets_ro.url
set -euo pipefail
umask 077
cmd="${1:-}"
PSQL_ADMIN="${PSQL_ADMIN:-sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d boombala}"
TTL_HOURS="${TTL_HOURS:-48}"
TUNNEL_PORT="${TUNNEL_PORT:-55432}"
DB_NAME="${DB_NAME:-boombala}"
URL_FILE="${URL_FILE:-$HOME/.bb_sheets_ro.url}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2086
admin() { $PSQL_ADMIN "$@"; }

case "$cmd" in
  create)
    [[ "$TTL_HOURS" =~ ^[0-9]{1,3}$ ]] || { echo "TTL_HOURS must be a number" >&2; exit 2; }
    [[ -e "$URL_FILE" ]] && { echo "$URL_FILE already exists: run '$0 revoke' first" >&2; exit 2; }
    pw="$(openssl rand -hex 24)"                       # hex: safe inside a URL and inside SQL
    # Password travels on stdin (a builtin printf, not argv), so it never shows in `ps` or in shell history.
    { printf "SET password_encryption = 'scram-sha-256';\n";
      printf "DO \$r\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro') THEN CREATE ROLE bb_sheets_ro LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER CONNECTION LIMIT 2; END IF; END \$r\$;\n";
      printf "ALTER ROLE bb_sheets_ro PASSWORD '%s';\n" "$pw";
      printf "DO \$r\$ BEGIN EXECUTE format('ALTER ROLE bb_sheets_ro VALID UNTIL %%L', (now() + interval '%s hours')::text); END \$r\$;\n" "$TTL_HOURS";
      printf "ALTER ROLE bb_sheets_ro SET default_transaction_read_only = on;\n";
      printf "ALTER ROLE bb_sheets_ro SET statement_timeout = '30s';\n";
      printf "ALTER ROLE bb_sheets_ro SET idle_in_transaction_session_timeout = '30s';\n";
    } | admin >/dev/null
    admin -f "$HERE/sql/sheets-ro-grant.sql" >/dev/null
    printf "postgres://bb_sheets_ro:%s@127.0.0.1:%s/%s\n" "$pw" "$TUNNEL_PORT" "$DB_NAME" > "$URL_FILE"
    chmod 600 "$URL_FILE"
    unset pw
    echo "role bb_sheets_ro created, expires in ${TTL_HOURS}h; connection URL saved to $URL_FILE (mode 600, not printed)"
    ;;
  revoke)
    admin <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bb_sheets_ro';
DO $r$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro') THEN
  EXECUTE 'DROP OWNED BY bb_sheets_ro'; EXECUTE 'DROP ROLE bb_sheets_ro'; END IF; END $r$;
SQL
    if [[ -e "$URL_FILE" ]]; then
      if command -v shred >/dev/null 2>&1; then shred -u "$URL_FILE"; else rm -f "$URL_FILE"; fi
    fi
    echo "role bb_sheets_ro dropped; $URL_FILE removed"
    ;;
  status)
    admin -t -A -c "SELECT CASE WHEN count(*)=0 THEN 'role bb_sheets_ro: absent' ELSE 'role bb_sheets_ro: present, valid until ' || coalesce(max(rolvaliduntil)::text,'never') END FROM pg_roles WHERE rolname='bb_sheets_ro'"
    ;;
  *) echo "usage: $0 create|revoke|status" >&2; exit 2 ;;
esac
