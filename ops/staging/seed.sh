#!/usr/bin/env bash
# Synthetic staging data only: branches, rooms, packages, FastAPI admins, Platform staff with known test passwords, and the
# explicit links between them. Refuses to run unless the database name is a staging one (guard.sh). Usage: seed.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
"$HERE/guard.sh" >/dev/null
[ -n "${STAGING_TEST_PASSWORD:-}" ] || { echo "set STAGING_TEST_PASSWORD (12+ chars, test-only) in the environment" >&2; exit 2; }
export_backend_env
( cd "$BACKEND_DIR/backend" && "$STAGING_ROOT/venv/bin/python" "$HERE/seed/seed_calendar.py" && "$STAGING_ROOT/venv/bin/python" "$HERE/seed/add_owners.py" )
export DATABASE_URL="postgres://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_PLATFORM_DB"
cd "$PLATFORM_DIR"
for account in "owner-a:stg-owner-a" "owner-b:stg-owner-b" "manager-a:stg-manager-a" "manager-b:stg-manager-b"; do
  email="${account%%:*}@staging.boombala.example.com"
  link="${account##*:}"
  BB_PASSWORD="$STAGING_TEST_PASSWORD" npm run -s user:create -- --email "$email" --name "Staging ${account%%:*}" --role "$( [[ "$account" == owner-* ]] && echo owner || echo manager )" >/dev/null 2>&1 || true
  BB_PASSWORD="$STAGING_TEST_PASSWORD" npm run -s user:set-password -- --email "$email" >/dev/null 2>&1 || true
  npm run -s user:link-fastapi -- --email "$email" --admin-user-id "$link"
done
say "synthetic staging data seeded and linked"
