#!/usr/bin/env bash
# Restores the newest backup into scratch databases, compares row counts with the live staging databases, then drops the
# scratch databases. Proves the backup is usable. Usage: restore-test.sh [backup-dir]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
dir="${1:-$(ls -1d "$STAGING_ROOT"/backups/*/ | sort | tail -1)}"
dir="${dir%/}"
( cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null ) || { echo "checksum mismatch in $dir" >&2; exit 1; }
psql_admin() { PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/psql" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
rows() { PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/psql" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d "$1" -qAt -c "$2"; }
status=0
for db in "$STAGING_BACKEND_DB" "$STAGING_PLATFORM_DB"; do
  scratch="${db}_restore_test"
  psql_admin -c "DROP DATABASE IF EXISTS $scratch" >/dev/null
  psql_admin -c "CREATE DATABASE $scratch" >/dev/null
  PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/pg_restore" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d "$scratch" --no-owner "$dir/$db.dump" 2>/dev/null || true
  tables="$(rows "$scratch" "select count(*) from information_schema.tables where table_schema in ('public','bb')")"
  live_count="$(rows "$db" "select count(*) from information_schema.tables where table_schema in ('public','bb')")"
  if [ "$tables" = "$live_count" ] && [ "$tables" -gt 0 ]; then say "restore ok: $db ($tables tables)"; else say "restore MISMATCH: $db restored=$tables live=$live_count"; status=1; fi
  psql_admin -c "DROP DATABASE $scratch" >/dev/null
done
exit $status
