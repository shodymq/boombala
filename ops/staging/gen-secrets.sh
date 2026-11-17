#!/usr/bin/env bash
# Creates the staging-only secrets once (mode 600). Never prints them. Existing values are kept.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
file="$STAGING_ROOT/secrets.env"
umask 077
touch "$file"
add() { grep -q "^$1=" "$file" || printf '%s=%s\n' "$1" "$(openssl rand -hex "$2")" >>"$file"; }
add CRM_SERVICE_TOKEN 32
add CRM_STAFF_ASSERTION_SECRET 32
add JWT_SECRET_KEY 32
add TICKET_QR_SECRET 32
add STAGING_PG_PASSWORD 24
chmod 600 "$file"
say "secrets present in $file (mode 600); values not printed"
