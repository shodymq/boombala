#!/usr/bin/env bash
# Restores the newest backup into scratch databases with strict pg_restore and compares every key table with the manifest
# written at backup time: row counts and checksums of money, requests, reservations, staff and audit rows. Any mismatch,
# checksum failure or restore error fails the run. Scratch databases are dropped on exit. Usage: restore-test.sh [backup-dir]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
dir="${1:-$(ls -1d "$STAGING_ROOT"/backups/*/ | sort | tail -1)}"
dir="${dir%/}"
scratches=()
cleanup() { for s in "${scratches[@]:-}"; do [ -n "$s" ] && drop_db "$s"; done; }
trap cleanup EXIT

( cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null ) || { echo "FAIL checksum mismatch in $dir" >&2; exit 1; }
failures=0
for pair in "$STAGING_BACKEND_DB:$CRM_TABLES" "$STAGING_PLATFORM_DB:$PLATFORM_TABLES"; do
  db="${pair%%:*}"; tables="${pair#*:}"
  scratch="${db}_restore_test"; scratches+=("$scratch")
  if ! restore_strict "$dir/$db.dump" "$scratch"; then failures=$((failures+1)); continue; fi
  # shellcheck disable=SC2086
  manifest_of "$scratch" $tables >"$STAGING_ROOT/logs/restored-$db.manifest"
  if diff -u "$dir/$db.manifest" "$STAGING_ROOT/logs/restored-$db.manifest" >"$STAGING_ROOT/logs/diff-$db.txt"; then
    say "PASS $db: restored data matches the manifest ($(wc -l <"$dir/$db.manifest" | tr -d ' ') tables)"
  else
    say "FAIL $db: restored data differs (see logs/diff-$db.txt)"; failures=$((failures+1))
  fi
done
if [ "$failures" -gt 0 ]; then say "restore test FAILED ($failures)"; exit 1; fi
say "restore test PASSED"
