#!/usr/bin/env bash
# Shared helpers for the staging scripts. Sourced, never executed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_env() {
  local file="${STAGING_ENV:-$HERE/staging.env}"
  [ -f "$file" ] || { echo "missing $file (copy staging.env.example)" >&2; exit 2; }
  # Values passed by the caller (rollback.sh pins a SHA pair) win over the file: the file is the default, not the override.
  local keep_backend="${BACKEND_SHA:-}" keep_platform="${PLATFORM_SHA:-}"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
  [ -z "$keep_backend" ] || BACKEND_SHA="$keep_backend"
  [ -z "$keep_platform" ] || PLATFORM_SHA="$keep_platform"
  export BACKEND_SHA PLATFORM_SHA
  STAGING_ROOT="$(eval echo "$STAGING_ROOT")"
  BACKEND_DIR="$(eval echo "$BACKEND_DIR")"
  PLATFORM_DIR="$(eval echo "$PLATFORM_DIR")"
  mkdir -p "$STAGING_ROOT"/{run,logs,backups,releases}
}

load_secrets() {
  local file="$STAGING_ROOT/secrets.env"
  [ -f "$file" ] || { echo "missing $file: run gen-secrets.sh first" >&2; exit 2; }
  local mode
  # GNU stat first: on Linux "stat -f" reports the filesystem, not the file mode.
  mode="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")"
  [ "$mode" = "600" ] || { echo "$file must be mode 600 (is $mode)" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

# The FastAPI settings every backend process needs (migrations included). Staging values only; secrets come from secrets.env.
export_backend_env() {
  export DATABASE_URL="postgresql+psycopg://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_BACKEND_DB"
  export CRM_SERVICE_TOKEN CRM_STAFF_ASSERTION_SECRET JWT_SECRET_KEY TICKET_QR_SECRET
  export APP_ENV=test OTP_MOCK_MODE=true PAYMENT_PROVIDER=freedompay FREEDOMPAY_MOCK_MODE=true ONLINE_PAYMENTS_ENABLED=false
  export BIRTHDAY_BOOKING_ENABLED=true PUSH_NOTIFICATIONS_ENABLED=false CRM_BRIDGE_ALLOWED_IPS=127.0.0.1,::1
  export MEDIA_ROOT="$STAGING_ROOT/media"; mkdir -p "$MEDIA_ROOT"
}

say() { printf '[staging] %s\n' "$*"; }

# Tables whose content must survive a restore: money, requests, reservations, staff, audit. Used by backup and restore tests.
CRM_TABLES="admin_users branches birthday_packages birthday_booking_rooms birthday_requests birthday_payment_facts birthday_slot_reservations birthday_booking_audit birthday_payment_audit"
PLATFORM_TABLES="users sessions audit_log"

# Restores one dump into a fresh database. Any pg_restore error fails the call (no silent skips).
restore_strict() { # dump-file target-db
  local dump="$1" target="$2" log
  log="$STAGING_ROOT/logs/restore-$target.log"
  PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/psql" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d postgres -qAt -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\"" >/dev/null
  if ! PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/pg_restore" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" \
      -d "$target" --no-owner --exit-on-error "$dump" >"$log" 2>&1; then
    echo "pg_restore FAILED for $dump (see $log)" >&2
    tail -5 "$log" >&2
    return 1
  fi
}

# Manifest lines for one database, using the same connection settings as the staging services.
manifest_of() { # database tables...
  local db="$1"; shift
  PGHOST=127.0.0.1 PGPORT="$STAGING_PG_PORT" PGUSER="$STAGING_PG_USER" PGPASSWORD="$STAGING_PG_PASSWORD" \
    PSQL="$STAGING_PG_BIN/psql" "$HERE/manifest.sh" "$db" "$@"
}

drop_db() { # database
  PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/psql" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d postgres -qAt \
    -c "DROP DATABASE IF EXISTS \"$1\"" >/dev/null
}

# The checkouts must exist at the pinned SHAs before anything starts. This never deletes or re-clones: a missing or moved
# checkout stops the stack with a message, and the operator restores it from the pinned SHA.
ensure_checkouts() {
  [ -d "$BACKEND_DIR/backend" ] || { echo "backend checkout missing at $BACKEND_DIR (restore it at BACKEND_SHA)" >&2; exit 4; }
  [ -f "$PLATFORM_DIR/package.json" ] || { echo "platform checkout missing at $PLATFORM_DIR (restore it at PLATFORM_SHA)" >&2; exit 4; }
  local root
  root="$(git -C "$PLATFORM_DIR" rev-parse --show-toplevel 2>/dev/null)" || { echo "platform checkout is not a git repository" >&2; exit 4; }
  local head
  head="$(git -C "$root" rev-parse HEAD)"
  if [ -n "${PLATFORM_SHA:-}" ] && [ "$head" != "$PLATFORM_SHA" ] && ! git -C "$root" merge-base --is-ancestor "$PLATFORM_SHA" "$head" 2>/dev/null; then
    echo "platform checkout is at $head, not at pinned $PLATFORM_SHA" >&2; exit 4
  fi
}
