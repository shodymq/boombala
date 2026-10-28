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
