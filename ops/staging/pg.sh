#!/usr/bin/env bash
# Starts or stops the isolated staging PostgreSQL cluster. Usage: pg.sh init|start|stop|status
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
DATA="$STAGING_ROOT/pgdata"
LOG="$STAGING_ROOT/logs/postgres.log"
case "${1:-status}" in
  init)
    [ -d "$DATA" ] && { say "cluster already initialised"; exit 0; }
    load_secrets
    pwfile="$(mktemp)"; chmod 600 "$pwfile"; printf '%s' "$STAGING_PG_PASSWORD" >"$pwfile"
    "$STAGING_PG_BIN/initdb" -D "$DATA" -U "$STAGING_PG_USER" --pwfile="$pwfile" -E UTF8 --locale=C >/dev/null
    rm -f "$pwfile"
    say "cluster initialised at $DATA (not the production cluster)"
    ;;
  start)
    "$STAGING_PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" -o "-p $STAGING_PG_PORT -c listen_addresses=127.0.0.1" -w start
    ;;
  stop)
    "$STAGING_PG_BIN/pg_ctl" -D "$DATA" -m fast stop || true
    ;;
  status)
    "$STAGING_PG_BIN/pg_ctl" -D "$DATA" status || true
    ;;
  *) echo "usage: pg.sh init|start|stop|status" >&2; exit 2 ;;
esac
