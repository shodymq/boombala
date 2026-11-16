#!/usr/bin/env bash
# Temporary read-only PostgreSQL role for the Google Sheets reconciliation.
#   create : creates bb_sheets_ro (expires automatically), grants column-level SELECT, writes the connection URL to a
#            mode-600 file. The password is generated here, goes to psql through stdin only, and is never printed.
#   revoke : terminates its sessions, drops the role and its grants, shreds the URL file.
#   stage-create : separate database + role for the importer's own staging table (sheet_import.rows). It has no access to bb.*.
#   stage-drop   : removes that database and role and its URL file.
#   status : shows whether the role exists and when it expires (no secrets).
# Never applies a migration, never writes to bb.*.
#
# Env (all optional):
#   PSQL_ADMIN   admin psql command, default: sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d boombala
#   TTL_HOURS    role lifetime, default 48
#   TUNNEL_PORT  PostgreSQL port written into the URLs, default 55432 (sheets-vps-run.sh sets 5432)
#   DB_NAME      database name inside the URL, default boombala
#   URL_FILE     where the URL is written, default $HOME/.bb_sheets_ro.url
#   HOST_IN_URL  host in the URL, default 127.0.0.1
#   STAGE_URL_FILE / STAGE_DB  staging URL file (default $HOME/.bb_sheets_stage.url) and database name (default bb_sheet_staging)
set -euo pipefail
umask 077
cmd="${1:-}"
PSQL_ADMIN="${PSQL_ADMIN:-sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d boombala}"
TTL_HOURS="${TTL_HOURS:-48}"
TUNNEL_PORT="${TUNNEL_PORT:-55432}"
DB_NAME="${DB_NAME:-boombala}"
URL_FILE="${URL_FILE:-$HOME/.bb_sheets_ro.url}"
HOST_IN_URL="${HOST_IN_URL:-127.0.0.1}"
STAGE_URL_FILE="${STAGE_URL_FILE:-$HOME/.bb_sheets_stage.url}"
STAGE_DB="${STAGE_DB:-bb_sheet_staging}"
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
    printf "postgres://bb_sheets_ro:%s@%s:%s/%s\n" "$pw" "$HOST_IN_URL" "$TUNNEL_PORT" "$DB_NAME" > "$URL_FILE"
    chmod 600 "$URL_FILE"
    unset pw
    echo "role bb_sheets_ro created, expires in ${TTL_HOURS}h; connection URL saved to $URL_FILE (mode 600, not printed)"
    ;;
  revoke)
    admin <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bb_sheets_ro';
DO $r$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['rooms','packages','lead_requests','contacts','slot_reservations','time_slots'] LOOP
    IF to_regclass('bb.' || t) IS NOT NULL THEN EXECUTE format('DROP POLICY IF EXISTS sheets_ro_select ON bb.%I', t); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_ro') THEN
    EXECUTE 'DROP OWNED BY bb_sheets_ro'; EXECUTE 'DROP ROLE bb_sheets_ro'; END IF;
END $r$;
SQL
    if [[ -e "$URL_FILE" ]]; then
      if command -v shred >/dev/null 2>&1; then shred -u "$URL_FILE"; else rm -f "$URL_FILE"; fi
    fi
    echo "role bb_sheets_ro dropped; $URL_FILE removed"
    ;;
  stage-create)
    if [[ -e "$STAGE_URL_FILE" ]]; then echo "staging already prepared ($STAGE_URL_FILE exists)"; exit 0; fi
    spw="$(openssl rand -hex 24)"
    { printf "DO \$r\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bb_sheets_stage') THEN CREATE ROLE bb_sheets_stage LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END \$r\$;\n";
      printf "ALTER ROLE bb_sheets_stage PASSWORD '%s';\n" "$spw";
    } | admin >/dev/null
    # CREATE DATABASE cannot run inside a DO block or transaction: separate call, only when absent.
    if [[ "$(admin -t -A -c "SELECT 1 FROM pg_database WHERE datname='$STAGE_DB'")" != "1" ]]; then
      admin -c "CREATE DATABASE $STAGE_DB OWNER bb_sheets_stage" >/dev/null
    fi
    printf "postgres://bb_sheets_stage:%s@%s:%s/%s\n" "$spw" "$HOST_IN_URL" "$TUNNEL_PORT" "$STAGE_DB" > "$STAGE_URL_FILE"
    chmod 600 "$STAGE_URL_FILE"; unset spw
    echo "staging database $STAGE_DB ready (separate from $DB_NAME); URL saved to $STAGE_URL_FILE (mode 600, not printed)"
    ;;
  stage-drop)
    admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$STAGE_DB'" >/dev/null
    admin -c "DROP DATABASE IF EXISTS $STAGE_DB" >/dev/null
    admin -c "DROP ROLE IF EXISTS bb_sheets_stage" >/dev/null
    if [[ -e "$STAGE_URL_FILE" ]]; then if command -v shred >/dev/null 2>&1; then shred -u "$STAGE_URL_FILE"; else rm -f "$STAGE_URL_FILE"; fi; fi
    echo "staging database and role removed"
    ;;
  status)
    admin -t -A -c "SELECT CASE WHEN count(*)=0 THEN 'role bb_sheets_ro: absent' ELSE 'role bb_sheets_ro: present, valid until ' || coalesce(max(rolvaliduntil)::text,'never') END FROM pg_roles WHERE rolname='bb_sheets_ro'"
    ;;
  *) echo "usage: $0 create|revoke|status|stage-create|stage-drop" >&2; exit 2 ;;
esac
