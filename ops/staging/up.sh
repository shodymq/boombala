#!/usr/bin/env bash
# Starts the isolated staging stack on 127.0.0.1: PostgreSQL, FastAPI, Platform. Records the SHAs it runs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
"$HERE/guard.sh" >/dev/null
load_secrets
"$HERE/pg.sh" start >/dev/null 2>&1 || true

start_service() { # name port logfile -- command...
  local name="$1" port="$2" log="$3"; shift 3
  local pid_file="$STAGING_ROOT/run/$port.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then say "$name already running"; return; fi
  nohup "$@" >>"$log" 2>&1 &
  echo $! >"$pid_file"
  say "$name started (pid $(cat "$pid_file"), 127.0.0.1:$port)"
}

export_backend_env
start_service fastapi "$STAGING_FASTAPI_PORT" "$STAGING_ROOT/logs/fastapi.log" \
  bash -c "cd '$BACKEND_DIR/backend' && exec nice -n 5 '$STAGING_ROOT/venv/bin/uvicorn' app.main:app --host 127.0.0.1 --port $STAGING_FASTAPI_PORT --workers 1"

export DATABASE_URL="postgres://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_PLATFORM_DB"
export UNIFIED_FASTAPI_CRM_ENABLED=1 FASTAPI_ADMIN_BASE_URL="http://127.0.0.1:$STAGING_FASTAPI_PORT"
# Production build served locally (not the dev server): the same bundle a pilot would run. Built once per SHA.
if [ ! -f "$PLATFORM_DIR/.next/BUILD_ID" ] || [ "$(cat "$STAGING_ROOT/run/platform.built-sha" 2>/dev/null)" != "$PLATFORM_SHA" ]; then
  say "building platform at $PLATFORM_SHA (nice, one job)"
  ( cd "$PLATFORM_DIR" && nice -n 10 npm run -s build )
  echo "$PLATFORM_SHA" >"$STAGING_ROOT/run/platform.built-sha"
fi
start_service platform "$STAGING_PLATFORM_PORT" "$STAGING_ROOT/logs/platform.log" \
  bash -c "cd '$PLATFORM_DIR' && exec ./node_modules/.bin/next start -p $STAGING_PLATFORM_PORT -H 127.0.0.1"

printf '%s fastapi=%s platform=%s\n' "$(date -u +%FT%TZ)" "$BACKEND_SHA" "$PLATFORM_SHA" >>"$STAGING_ROOT/releases/history.log"
