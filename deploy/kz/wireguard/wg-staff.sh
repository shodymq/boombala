#!/usr/bin/env bash
# Devices of employees on the Boom Bala VPN: add, revoke, list. Run as root on the Kazakhstan VPS.
#   wg-staff.sh add    --name "Aigerim iPhone" --email a@example.org --role manager --pubkey <PUBLIC KEY OF THE DEVICE>
#   wg-staff.sh revoke --id <device id>        (one device)
#   wg-staff.sh revoke --email a@example.org   (every device of a person: use it the moment someone leaves)
#   wg-staff.sh list
#   wg-staff.sh restore                        (re-applies every ACTIVE device after a restart; used by systemd)
# A revoked device loses the network path at once. Also disable the account in the admin ("Отключить"): it ends the sessions.
# Overridable for tests: WG_BIN, STATE_DIR, WG_IFACE, WG_SUBNET_PREFIX, SERVER_PUBLIC_KEY, VPN_ENDPOINT, WG_PORT, WG_SERVER_ADDR.
set -euo pipefail
umask 077

WG_BIN="${WG_BIN:-wg}"
WG_IFACE="${WG_IFACE:-wg0}"
STATE_DIR="${STATE_DIR:-/var/lib/boombala/vpn}"
WG_SUBNET_PREFIX="${WG_SUBNET_PREFIX:-10.77.0}"
WG_SERVER_ADDR="${WG_SERVER_ADDR:-${WG_SUBNET_PREFIX}.1}"
WG_PORT="${WG_PORT:-51820}"
REGISTRY="$STATE_DIR/devices.tsv"
PEERS_DIR="$STATE_DIR/peers.d"
FIRST_HOST=10
LAST_HOST=250

die() { echo "error: $*" >&2; exit 1; }
need() { [ -n "${2:-}" ] || die "missing --$1"; }

mkdir -p "$PEERS_DIR"
[ -f "$REGISTRY" ] || printf 'id\tname\temail\trole\tip\tpubkey\tadded_at\trevoked_at\n' > "$REGISTRY"

arg() { # arg <name> <args...>: value of --name
  local key="--$1"; shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$key" ]; then echo "${2:-}"; return; fi
    shift
  done
}

valid_pubkey() { [[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]]; }
valid_text() { [[ "$1" != *$'\t'* && "$1" != *$'\n'* && ${#1} -le 120 ]]; }

next_ip() {
  local n used
  used="$(awk -F'\t' 'NR>1 && $8=="" {print $5}' "$REGISTRY")"
  for ((n = FIRST_HOST; n <= LAST_HOST; n++)); do
    if ! grep -qx "${WG_SUBNET_PREFIX}.${n}" <<<"$used"; then echo "${WG_SUBNET_PREFIX}.${n}"; return; fi
  done
  die "no free address left in ${WG_SUBNET_PREFIX}.0/24"
}

cmd_add() {
  local name email role pubkey id ip psk now
  name="$(arg name "$@")"; email="$(arg email "$@")"; role="$(arg role "$@")"; pubkey="$(arg pubkey "$@")"
  need name "$name"; need email "$email"; need role "$role"; need pubkey "$pubkey"
  [[ "$role" =~ ^(owner|manager|editor)$ ]] || die "role must be owner, manager or editor"
  valid_text "$name" && valid_text "$email" || die "name/email contain forbidden characters"
  valid_pubkey "$pubkey" || die "the public key is not a valid WireGuard key (44 characters, base64)"
  if awk -F'\t' -v k="$pubkey" 'NR>1 && $6==k && $8=="" {f=1} END{exit !f}' "$REGISTRY"; then die "this public key is already registered"; fi
  ip="$(next_ip)"
  id="d$(date +%s)$RANDOM"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  psk="$("$WG_BIN" genpsk)"
  printf '%s' "$psk" > "$PEERS_DIR/$id.psk"
  # AllowedIPs is exactly one address: a device cannot claim another device's address (no spoofing inside the VPN).
  "$WG_BIN" set "$WG_IFACE" peer "$pubkey" preshared-key "$PEERS_DIR/$id.psk" allowed-ips "${ip}/32"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t\n' "$id" "$name" "$email" "$role" "$ip" "$pubkey" "$now" >> "$REGISTRY"
  cat <<OUT
Device registered: id=$id address=$ip
Give the employee this configuration over a safe channel (in person or an end-to-end encrypted messenger), then delete it from the chat:

[Interface]
PrivateKey = <the key the WireGuard app generated on the device>
Address = ${ip}/32
DNS = ${WG_SERVER_ADDR}

[Peer]
PublicKey = ${SERVER_PUBLIC_KEY:-<server public key: wg show $WG_IFACE public-key>}
PresharedKey = $psk
Endpoint = ${VPN_ENDPOINT:-<server address>}:${WG_PORT}
AllowedIPs = ${WG_SERVER_ADDR}/32
PersistentKeepalive = 25
OUT
}

revoke_row() { # revoke_row <id> <pubkey>
  "$WG_BIN" set "$WG_IFACE" peer "$2" remove
  rm -f "$PEERS_DIR/$1.psk"
  local now tmp; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; tmp="$(mktemp)"
  awk -F'\t' -v OFS='\t' -v id="$1" -v now="$now" 'NR>1 && $1==id && $8=="" {$8=now} {print}' "$REGISTRY" > "$tmp"
  cat "$tmp" > "$REGISTRY"; rm -f "$tmp"
}

cmd_revoke() {
  local id email rows count=0 rid rpub
  id="$(arg id "$@")"; email="$(arg email "$@")"
  [ -n "$id" ] || [ -n "$email" ] || die "give --id or --email"
  if [ -n "$id" ]; then
    rows="$(awk -F'\t' -v id="$id" 'NR>1 && $1==id && $8=="" {print $1"\t"$6}' "$REGISTRY")"
  else
    rows="$(awk -F'\t' -v e="$email" 'NR>1 && $3==e && $8=="" {print $1"\t"$6}' "$REGISTRY")"
  fi
  [ -n "$rows" ] || die "no active device matches"
  while IFS=$'\t' read -r rid rpub; do
    revoke_row "$rid" "$rpub"; count=$((count + 1))
    echo "revoked $rid"
  done <<<"$rows"
  echo "$count device(s) revoked. Now disable the account in the admin (Сотрудники → Отключить) so open sessions end too."
}

cmd_list() { awk -F'\t' 'NR==1 || $8=="" {print}' "$REGISTRY" | column -t -s $'\t' 2>/dev/null || awk -F'\t' 'NR==1 || $8=="" {print}' "$REGISTRY"; }

cmd_restore() {
  local id ip pub n=0
  while IFS=$'\t' read -r id ip pub; do
    [ -n "$id" ] || continue
    "$WG_BIN" set "$WG_IFACE" peer "$pub" preshared-key "$PEERS_DIR/$id.psk" allowed-ips "${ip}/32"
    n=$((n + 1))
  done < <(awk -F'\t' 'NR>1 && $8=="" {print $1"\t"$5"\t"$6}' "$REGISTRY")
  echo "$n device(s) restored"
}

case "${1:-}" in
  restore) cmd_restore ;;
  add) shift; cmd_add "$@" ;;
  revoke) shift; cmd_revoke "$@" ;;
  list) cmd_list ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
