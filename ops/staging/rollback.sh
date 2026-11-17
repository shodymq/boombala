#!/usr/bin/env bash
# Rolls the staging stack back to a previous recorded SHA pair. Data is not touched; schema is not reverted (run restore-test
# and restore a backup taken before the migration if the schema must go back). Usage: rollback.sh <backend-sha> <platform-sha>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
backend_sha="${1:?usage: rollback.sh <backend-sha> <platform-sha>}"
platform_sha="${2:?usage: rollback.sh <backend-sha> <platform-sha>}"
"$HERE/down.sh" >/dev/null
git -C "$BACKEND_DIR" checkout -q --detach "$backend_sha"
git -C "$PLATFORM_DIR" checkout -q --detach "$platform_sha"
say "checked out fastapi=$backend_sha platform=$platform_sha"
BACKEND_SHA="$backend_sha" PLATFORM_SHA="$platform_sha" "$HERE/up.sh"
printf '%s ROLLBACK fastapi=%s platform=%s\n' "$(date -u +%FT%TZ)" "$backend_sha" "$platform_sha" >>"$STAGING_ROOT/releases/history.log"
