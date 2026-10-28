#!/usr/bin/env bash
# Refuses to run staging if it would touch production: live ports, production database names, a root user, or a
# nginx/DNS change. Run before every up/migrate/backup. Read-only.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

fail() { echo "GUARD FAILED: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run as the staging user, never root"

for port in "$STAGING_FASTAPI_PORT" "$STAGING_PLATFORM_PORT" "$STAGING_PG_PORT"; do
  for protected in $PROTECTED_PORTS; do
    [ "$port" != "$protected" ] || fail "port $port is a protected live port"
  done
done
# The staging services must either be free or be our own processes; the staging PostgreSQL port may already be running.
for port in "$STAGING_FASTAPI_PORT" "$STAGING_PLATFORM_PORT"; do
  if (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    # Already listening: allowed only when it is our own staging process (pid file present and alive).
    pid_file="$STAGING_ROOT/run/$port.pid"
    [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null || fail "port $port is in use by something that is not staging"
  fi
done

for name in "$STAGING_BACKEND_DB" "$STAGING_PLATFORM_DB"; do
  for marker in $PRODUCTION_MARKERS; do
    case "$name" in *"$marker"*) fail "database name $name contains production marker $marker" ;; esac
  done
done

# Database target: this host, a non-protected port, and (when the cluster answers) the staging data directory.
assert_local_port || fail "database target refused"
if "$STAGING_PG_BIN/pg_isready" -h 127.0.0.1 -p "$STAGING_PG_PORT" -q 2>/dev/null; then
  assert_staging_cluster || fail "cluster on $STAGING_PG_PORT is not the staging cluster"
fi

[ -d "$BACKEND_DIR/backend" ] || fail "BACKEND_DIR does not contain backend/: $BACKEND_DIR"
[ -f "$PLATFORM_DIR/package.json" ] || fail "PLATFORM_DIR does not contain package.json: $PLATFORM_DIR"

say "guard ok: ports $STAGING_FASTAPI_PORT $STAGING_PLATFORM_PORT $STAGING_PG_PORT, databases $STAGING_BACKEND_DB $STAGING_PLATFORM_DB"
