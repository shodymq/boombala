#!/usr/bin/env bash
# Daily check that BOTH repositories really hold usable backups. A failure alerts (see bb-backup-check.service).
# For each repository separately: the stanza is healthy, there is a recent backup, a full backup within the last
# MAX_FULL_AGE_DAYS, the WAL archive is present, and pgBackRest's own integrity check (`verify`) passes.
#   check-backups.sh
# Overridable for tests: PGBACKREST_BIN, STANZA, REPOS, MAX_BACKUP_AGE_HOURS, MAX_FULL_AGE_DAYS, NOW_EPOCH, RUN_VERIFY.
set -uo pipefail
PGB="${PGBACKREST_BIN:-pgbackrest}"; STANZA="${STANZA:-boombala}"
REPOS="${REPOS:-1 2}"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-30}"
MAX_FULL_AGE_DAYS="${MAX_FULL_AGE_DAYS:-8}"
RUN_VERIFY="${RUN_VERIFY:-1}"
NOW="${NOW_EPOCH:-$(date +%s)}"
fails=0
note() { echo "$*"; }
bad() { echo "FAIL  repo$1: $2"; fails=$((fails + 1)); }

for repo in $REPOS; do
  json="$("$PGB" --stanza="$STANZA" --repo="$repo" --output=json info 2>/dev/null)" || { bad "$repo" "pgbackrest info failed"; continue; }
  verdict="$(printf '%s' "$json" | node -e '
    const [stanza, now, maxH, maxD] = process.argv.slice(1);
    let data; try { data = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { console.log("unreadable info output"); process.exit(0); }
    const s = (Array.isArray(data) ? data : []).find((x) => x.name === stanza);
    if (!s) { console.log("stanza not found in this repository"); process.exit(0); }
    if (!s.status || s.status.code !== 0) { console.log("stanza status is not ok: " + (s.status && s.status.message)); process.exit(0); }
    const backups = (s.backup || []).filter((b) => b.timestamp && b.timestamp.stop);
    if (backups.length === 0) { console.log("no backup at all"); process.exit(0); }
    const age = (b) => Number(now) - b.timestamp.stop;
    const newest = Math.min(...backups.map(age));
    if (newest > Number(maxH) * 3600) { console.log("newest backup is " + Math.round(newest / 3600) + " h old (limit " + maxH + " h)"); process.exit(0); }
    const fulls = backups.filter((b) => b.type === "full");
    if (fulls.length === 0) { console.log("no full backup"); process.exit(0); }
    const newestFull = Math.min(...fulls.map(age));
    if (newestFull > Number(maxD) * 86400) { console.log("newest full backup is " + Math.round(newestFull / 86400) + " days old (limit " + maxD + " days)"); process.exit(0); }
    const wal = (s.archive || []).filter((a) => a.min && a.max);
    if (wal.length === 0) { console.log("WAL archive is empty"); process.exit(0); }
    console.log("OK");
  ' "$STANZA" "$NOW" "$MAX_BACKUP_AGE_HOURS" "$MAX_FULL_AGE_DAYS")"
  if [ "$verdict" != "OK" ]; then bad "$repo" "$verdict"; continue; fi
  if [ "$RUN_VERIFY" = "1" ] && ! "$PGB" --stanza="$STANZA" --repo="$repo" verify >/dev/null 2>&1; then bad "$repo" "pgbackrest verify failed"; continue; fi
  note "PASS  repo$repo: recent backup, full backup, WAL archive and integrity are in order"
done
[ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
[ "$fails" -eq 0 ]
