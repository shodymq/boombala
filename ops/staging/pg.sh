#!/usr/bin/env bash
# Starts, stops and checks the isolated staging PostgreSQL cluster. Usage: pg.sh init|start|stop|status|ready
# Errors are not hidden: a failed start prints the server log and exits non-zero; "ready" proves the cluster accepts a login.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
DATA="$STAGING_ROOT/pgdata"
LOG="$STAGING_ROOT/logs/postgres.log"
PG_CTL="$STAGING_PG_BIN/pg_ctl"

# The data directory must be ours: under STAGING_ROOT, never a system or production path.
own_data_dir() {
  [ -d "$DATA" ] || return 0
  local real
  real="$(cd "$DATA" && pwd -P)"
  case "$real" in
    "$(cd "$STAGING_ROOT" && pwd -P)"/*) ;;
    *) fail_target "data directory $real is outside STAGING_ROOT" ;;
  esac
  case "$real" in /var/lib/postgresql*|/usr/*) fail_target "data directory $real is a system path" ;; esac
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    if "$STAGING_PG_BIN/pg_isready" -h 127.0.0.1 -p "$STAGING_PG_PORT" -q; then
      if PGPASSWORD="$STAGING_PG_PASSWORD" "$STAGING_PG_BIN/psql" -h 127.0.0.1 -p "$STAGING_PG_PORT" -U "$STAGING_PG_USER" -d postgres -qAt -c 'select 1' >/dev/null 2>&1; then
        say "cluster ready on 127.0.0.1:$STAGING_PG_PORT"
        return 0
      fi
    fi
    sleep 1
  done
  echo "cluster on 127.0.0.1:$STAGING_PG_PORT did not become ready in 30s; last log lines:" >&2
  tail -20 "$LOG" >&2 2>/dev/null || true
  return 1
}

case "${1:-status}" in
  init)
    [ ! -d "$DATA" ] || { say "cluster already initialised at $DATA"; exit 0; }
    load_secrets
    pwfile="$(mktemp)"; chmod 600 "$pwfile"; printf '%s' "$STAGING_PG_PASSWORD" >"$pwfile"
    "$STAGING_PG_BIN/initdb" -D "$DATA" -U "$STAGING_PG_USER" --pwfile="$pwfile" -E UTF8 --locale=C >/dev/null
    rm -f "$pwfile"
    say "cluster initialised at $DATA (not the production cluster)"
    ;;
  start)
    own_data_dir
    [ -d "$DATA" ] || { echo "no cluster at $DATA: run pg.sh init first" >&2; exit 1; }
    if "$STAGING_PG_BIN/pg_isready" -h 127.0.0.1 -p "$STAGING_PG_PORT" -q; then
      say "cluster already accepting connections on $STAGING_PG_PORT"
    else
      # Unix socket in the staging run directory: the system socket directory belongs to the production cluster.
      "$PG_CTL" -D "$DATA" -l "$LOG" -t 60 \
        -o "-p $STAGING_PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$STAGING_ROOT/run" -w start \
        || { echo "pg_ctl start failed; last log lines:" >&2; tail -20 "$LOG" >&2; exit 1; }
    fi
    load_secrets
    wait_ready
    ;;
  stop)
    own_data_dir
    if [ ! -f "$DATA/postmaster.pid" ]; then say "cluster not running"; exit 0; fi
    "$PG_CTL" -D "$DATA" -m fast -w -t 60 stop || { echo "pg_ctl stop failed" >&2; exit 1; }
    say "cluster stopped"
    ;;
  status)
    own_data_dir
    "$PG_CTL" -D "$DATA" status
    ;;
  ready)
    load_secrets
    wait_ready
    ;;
  *) echo "usage: pg.sh init|start|stop|status|ready" >&2; exit 2 ;;
esac
