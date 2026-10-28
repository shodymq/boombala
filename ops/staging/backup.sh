#!/usr/bin/env bash
# Dumps both staging databases (custom format) with a checksum. Staging data only.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$STAGING_ROOT/backups/$stamp"; mkdir -p "$dir"
for db in "$STAGING_BACKEND_DB" "$STAGING_PLATFORM_DB"; do
  PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/pg_dump" -Fc -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d "$db" -f "$dir/$db.dump"
done
( cd "$dir" && shasum -a 256 ./*.dump >SHA256SUMS )
say "backup written to $dir"
echo "$dir"
