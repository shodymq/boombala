#!/usr/bin/env bash
# Keeps the staging services up: runs up.sh (idempotent: starts only what is not running) every 30 seconds and logs the result.
# Run it as the long-lived process of the systemd user unit. It never deletes anything; a missing checkout is reported and
# retried, so the operator can restore it without a race.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
trap 'echo "[supervise] stopping"; exit 0' TERM INT
while true; do
  if "$HERE/up.sh" >>"$STAGING_ROOT/logs/supervise.log" 2>&1; then
    :
  else
    echo "$(date -u +%FT%TZ) up.sh failed; retrying in 30s" >>"$STAGING_ROOT/logs/supervise.log"
  fi
  sleep 30 &
  wait $!
done
