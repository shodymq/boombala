#!/usr/bin/env bash
# Creates the two pilot manager accounts for the closed synthetic staging: one Platform account and one FastAPI sales manager
# each, linked explicitly. Passwords are random, written only to $STAGING_ROOT/pilot-accounts.env (mode 600), never printed.
# Test data only. Run on the staging host. Usage: pilot-accounts.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
load_secrets
assert_staging_cluster
"$HERE/guard.sh" >/dev/null
export_backend_env
out="$STAGING_ROOT/pilot-accounts.env"
umask 077
[ -f "$out" ] || {
  : >"$out"
  for letter in a b; do
    printf 'PILOT_%s_EMAIL=pilot-%s@staging.boombala.example.com\nPILOT_%s_PASSWORD=%s\n' \
      "$(echo "$letter" | tr a-z A-Z)" "$letter" "$(echo "$letter" | tr a-z A-Z)" "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)" >>"$out"
  done
  chmod 600 "$out"
  say "pilot passwords generated into $out (mode 600; not printed)"
}
set -a; . "$out"; set +a

# FastAPI side: one sales manager per pilot person, no branch scope (global booking role, as the other managers).
( cd "$BACKEND_DIR/backend" && "$STAGING_ROOT/venv/bin/python" - <<'PY'
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db.models.admin_user import AdminUser
engine = create_engine(os.environ["DATABASE_URL"])
with sessionmaker(bind=engine)() as s:
    for letter in ("a", "b"):
        id_ = f"stg-pilot-{letter}"
        if s.get(AdminUser, id_) is None:
            s.add(AdminUser(id=id_, email=f"pilot-{letter}@staging.boombala.example.com", full_name=f"Пилот менеджер {letter.upper()}", password_hash="x", role="sales_manager", branch_id=None, is_active=True))
    s.commit()
print("fastapi pilot admins ready")
PY
)

# Platform side: one manager per pilot person, the password from the file, then the explicit link.
export DATABASE_URL="postgres://$STAGING_PG_USER:$STAGING_PG_PASSWORD@127.0.0.1:$STAGING_PG_PORT/$STAGING_PLATFORM_DB"
cd "$PLATFORM_DIR"
for letter in a b; do
  var="PILOT_$(echo "$letter" | tr a-z A-Z)"
  email="$(eval echo \$${var}_EMAIL)"; pw="$(eval echo \$${var}_PASSWORD)"
  BB_PASSWORD="$pw" npm run -s user:create -- --email "$email" --name "Пилот менеджер $(echo "$letter" | tr a-z A-Z)" --role manager >/dev/null 2>&1 || true
  BB_PASSWORD="$pw" npm run -s user:set-password -- --email "$email" >/dev/null 2>&1 || true
  npm run -s user:link-fastapi -- --email "$email" --admin-user-id "stg-pilot-$letter"
done
say "pilot accounts ready; credentials are in $out on this host only"
