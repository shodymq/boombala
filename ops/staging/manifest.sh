#!/usr/bin/env bash
# Prints a verifiable manifest of one database: for each named table, the row count and an order-independent checksum over
# every column. A changed payment, request or reservation changes its line.
# Usage: manifest.sh <database> <table>... ; connection from PGHOST, PGPORT, PGUSER, PGPASSWORD (set by the caller).
set -euo pipefail
db="$1"; shift
psql_q() { "${PSQL:-psql}" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -qAt -v ON_ERROR_STOP=1 -c "$1"; }
for t in "$@"; do
  qual="$(psql_q "select case when to_regclass('bb.$t') is not null then 'bb.$t' when to_regclass('public.$t') is not null then 'public.$t' end")"
  if [ -z "$qual" ]; then echo "ERROR $t missing in $db" >&2; exit 3; fi
  line="$(psql_q "select count(*)::text || ' ' || coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') from $qual x")"
  echo "$t $line"
done
