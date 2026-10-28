#!/usr/bin/env bash
# Opens SSH local forwards so a manager's browser on the operator's Mac reaches the staging services. Nothing is exposed
# to the internet: the forwards bind to 127.0.0.1 on the Mac. Usage: tunnel.sh <ssh-host-alias>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
host="${1:?usage: tunnel.sh <ssh-host-alias>}"
# The operator's ~/.ssh/config may set "ClearAllForwardings yes" for this host, which disables -L. That setting is deliberate;
# this script does not override it silently. Opt in for one session with ALLOW_FORWARDING=1 after reviewing the host entry.
extra=()
if [ "${ALLOW_FORWARDING:-0}" = "1" ]; then extra=(-o ClearAllForwardings=no); fi
if [ "$(ssh -G "$host" | awk '$1=="clearallforwardings"{print $2}')" = "yes" ] && [ "${ALLOW_FORWARDING:-0}" != "1" ]; then
  echo "host $host has ClearAllForwardings yes; set ALLOW_FORWARDING=1 to override for this session" >&2
  exit 3
fi
say "forwarding http://127.0.0.1:$STAGING_PLATFORM_PORT (CRM) and 127.0.0.1:$STAGING_FASTAPI_PORT (API) through $host; Ctrl-C to stop"
exec ssh -N -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "${extra[@]}" \
  -L "127.0.0.1:$STAGING_PLATFORM_PORT:127.0.0.1:$STAGING_PLATFORM_PORT" \
  -L "127.0.0.1:$STAGING_FASTAPI_PORT:127.0.0.1:$STAGING_FASTAPI_PORT" "$host"
