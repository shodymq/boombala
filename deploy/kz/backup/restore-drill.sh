#!/usr/bin/env bash
# Restore drill: proves that a backup can really be restored FROM EACH repository. Run on a SEPARATE scratch server (never the
# production one), monthly and after every change of the backup setup. Restores from repo1 AND repo2, each into its own empty directory.
#   RESTORE_TARGET_DIR=/var/lib/postgresql/16/drill [REPOS="1 2"] [PITR="2026-11-01 12:00:00+06"] ./restore-drill.sh
# The restored database holds real data once real data exists: use an encrypted disk and destroy the server afterwards.
# Overridable for tests: PGBACKREST_BIN, STANZA.
set -euo pipefail
: "${RESTORE_TARGET_DIR:?set RESTORE_TARGET_DIR}"
PGB="${PGBACKREST_BIN:-pgbackrest}"; STANZA="${STANZA:-boombala}"
REPOS="${REPOS:-1 2}"
fails=0
for repo in $REPOS; do
  [[ "$repo" =~ ^[12]$ ]] || { echo "unknown repository: $repo" >&2; exit 2; }
  target="$RESTORE_TARGET_DIR/repo$repo"
  [ -z "$(ls -A "$target" 2>/dev/null)" ] || { echo "refusing: $target is not empty" >&2; exit 1; }
  mkdir -p "$target"
  args=(--stanza="$STANZA" --repo="$repo" --pg1-path="$target")
  if [ -n "${PITR:-}" ]; then args+=(--type=time "--target=$PITR" --target-action=promote); fi
  if "$PGB" "${args[@]}" restore && [ -f "$target/PG_VERSION" ]; then
    echo "PASS  repo$repo restored into $target"
  else
    echo "FAIL  repo$repo could not be restored (or the result has no PG_VERSION)"; fails=$((fails + 1))
  fi
done
if [ "$fails" -eq 0 ]; then
  echo "Now start each restored copy on a spare port and run:  DATABASE_URL=... node platform/scripts/backup-restore-check.mjs  (row counts, migrations, the double-booking index, triggers, row security)."
  echo "After restoring real data, re-apply the recorded erasures: contacts listed as contact.anonymized in the audit log must be anonymised again."
fi
[ "$fails" -eq 0 ]
