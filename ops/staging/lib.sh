#!/usr/bin/env bash
# Shared helpers for the staging scripts. Sourced, never executed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_env() {
  local file="${STAGING_ENV:-$HERE/staging.env}"
  [ -f "$file" ] || { echo "missing $file (copy staging.env.example)" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
  STAGING_ROOT="$(eval echo "$STAGING_ROOT")"
  BACKEND_DIR="$(eval echo "$BACKEND_DIR")"
  PLATFORM_DIR="$(eval echo "$PLATFORM_DIR")"
  mkdir -p "$STAGING_ROOT"/{run,logs,backups,releases}
}

load_secrets() {
  local file="$STAGING_ROOT/secrets.env"
  [ -f "$file" ] || { echo "missing $file: run gen-secrets.sh first" >&2; exit 2; }
  local mode
  mode="$(stat -f %Lp "$file" 2>/dev/null || stat -c %a "$file")"
  [ "$mode" = "600" ] || { echo "$file must be mode 600 (is $mode)" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

say() { printf '[staging] %s\n' "$*"; }
