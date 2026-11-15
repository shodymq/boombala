#!/usr/bin/env bash
# Stops the staging services (FastAPI, Platform) and the staging PostgreSQL cluster. Keeps all data.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
for port in "$STAGING_FASTAPI_PORT" "$STAGING_PLATFORM_PORT"; do
  pid_file="$STAGING_ROOT/run/$port.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill "$(cat "$pid_file")" && say "stopped pid $(cat "$pid_file") on $port"
  fi
  rm -f "$pid_file"
done
"$HERE/pg.sh" stop
