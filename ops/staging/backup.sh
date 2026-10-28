#!/usr/bin/env bash
# Dumps both staging databases (custom format). For each dump, a manifest is computed from a strict restore of that same file,
# so the manifest describes what the dump actually contains. Writes SHA256SUMS over the dumps and manifests.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
assert_staging_cluster
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$STAGING_ROOT/backups/$stamp"; mkdir -p "$dir"
for pair in "$STAGING_BACKEND_DB:$CRM_TABLES" "$STAGING_PLATFORM_DB:$PLATFORM_TABLES"; do
  db="${pair%%:*}"; tables="${pair#*:}"
  PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/pg_dump" -Fc -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d "$db" -f "$dir/$db.dump"
  scratch="${db}_manifest_tmp"
  restore_strict "$dir/$db.dump" "$scratch"
  # shellcheck disable=SC2086
  manifest_of "$scratch" $tables >"$dir/$db.manifest"
  drop_db "$scratch"
  say "$db: $(wc -l <"$dir/$db.manifest" | tr -d ' ') tables in manifest"
done
( cd "$dir" && shasum -a 256 ./*.dump ./*.manifest >SHA256SUMS )
say "backup written to $dir"
echo "$dir"
