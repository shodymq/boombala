#!/usr/bin/env bash
# One backup into ONE repository. pgBackRest writes a backup only to the repository named with --repo (without it, only
# repo1 would ever receive backups while repo2 would hold nothing but WAL). Instances: full-1, diff-1, full-2, diff-2.
#   bb-backup.sh full-1
# Overridable for tests: PGBACKREST_BIN, STANZA.
set -euo pipefail
INSTANCE="${1:-}"
[[ "$INSTANCE" =~ ^(full|diff)-([12])$ ]] || { echo "usage: bb-backup.sh full-1|diff-1|full-2|diff-2" >&2; exit 2; }
TYPE="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"
exec "${PGBACKREST_BIN:-pgbackrest}" --stanza="${STANZA:-boombala}" --repo="$REPO" --type="$TYPE" backup
