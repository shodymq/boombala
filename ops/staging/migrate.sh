#!/usr/bin/env bash
# Runs both schema migrations against the staging databases only. Usage: migrate.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
assert_staging_cluster
"$HERE/guard.sh" >/dev/null
pg_url() { printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$STAGING_PG_USER" "$STAGING_PG_PASSWORD" "$STAGING_PG_PORT" "$1"; }
export DATABASE_URL="$(pg_url "$STAGING_PLATFORM_DB")"
( cd "$PLATFORM_DIR" && npm run -s db:migrate )
say "platform migrations applied"
export_backend_env
( cd "$BACKEND_DIR/backend" && "$STAGING_ROOT/venv/bin/alembic" upgrade head )
say "FastAPI migrations applied"
