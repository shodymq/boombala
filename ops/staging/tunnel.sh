#!/usr/bin/env bash
# Opens SSH local forwards so a manager's browser on the operator's Mac reaches the staging services. Nothing is exposed
# to the internet: the forwards bind to 127.0.0.1 on the Mac. Usage: tunnel.sh <ssh-host-alias>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
host="${1:?usage: tunnel.sh <ssh-host-alias>}"
say "forwarding http://127.0.0.1:$STAGING_PLATFORM_PORT (CRM) and 127.0.0.1:$STAGING_FASTAPI_PORT (API) through $host; Ctrl-C to stop"
exec ssh -N -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:$STAGING_PLATFORM_PORT:127.0.0.1:$STAGING_PLATFORM_PORT" \
  -L "127.0.0.1:$STAGING_FASTAPI_PORT:127.0.0.1:$STAGING_FASTAPI_PORT" "$host"
