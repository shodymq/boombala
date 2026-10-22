#!/usr/bin/env bash
# Restore drill: proves that a backup can really be restored. Run it on a SEPARATE scratch server (never on the production one),
# monthly and after every change of the backup setup. It restores the latest backup (or a point in time) and checks the result.
#   RESTORE_TARGET_DIR=/var/lib/postgresql/16/drill [PITR="2026-11-01 12:00:00+06"] ./restore-drill.sh
# The restored database holds real data once real data exists: use an encrypted disk and destroy the server afterwards.
set -euo pipefail
: "${RESTORE_TARGET_DIR:?set RESTORE_TARGET_DIR}"
STANZA="${STANZA:-boombala}"
[ -z "$(ls -A "$RESTORE_TARGET_DIR" 2>/dev/null)" ] || { echo "refusing: $RESTORE_TARGET_DIR is not empty" >&2; exit 1; }
args=(--stanza="$STANZA" --pg1-path="$RESTORE_TARGET_DIR")
if [ -n "${PITR:-}" ]; then args+=(--type=time "--target=$PITR" --target-action=promote); fi
pgbackrest "${args[@]}" restore
echo "restored into $RESTORE_TARGET_DIR."
echo "Now start it on a spare port and run:  DATABASE_URL=... node platform/scripts/backup-restore-check.mjs  (row counts, migrations, the double-booking index, triggers, row security)."
echo "After restoring real data, re-apply the recorded erasures: contacts listed as contact.anonymized in the audit log must be anonymised again."
