#!/usr/bin/env bash
# Fills the @PLACEHOLDERS@ of the templates from a file of KEY=VALUE lines and writes the result to an output directory.
#   render.sh deploy.env ./build
# deploy.env (NOT committed) holds the choices that are not secrets: domains, addresses, ports. Secrets are never rendered
# into config files: the env examples keep their @SECRET@ markers and are filled on the server by hand.
# Portable: plain POSIX tools only (works with the bash 3.2 of a laptop as well as the bash 5 of the server).
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: render.sh <deploy.env> <out-dir>" >&2; exit 2; }
ENV_FILE="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REQUIRED="ADMIN_HOST API_HOST PUBLIC_SITE_HOST PUBLIC_IP PUBLIC_IF WG_SERVER_ADDR WG_SUBNET WG_PORT ADMIN_PORT API_PORT DB_NAME"

SED_SCRIPT="$(mktemp)"
trap 'rm -f "$SED_SCRIPT"' EXIT
while IFS='=' read -r k v; do
  case "$k" in ''|\#*) continue ;; esac
  [[ "$k" =~ ^[A-Z_]+$ ]] || continue
  printf 's|@%s@|%s|g\n' "$k" "$(printf '%s' "$v" | sed 's/[|&\\]/\\&/g')" >> "$SED_SCRIPT"
done < "$ENV_FILE"
for k in $REQUIRED; do
  grep -q "^s|@${k}@|.\+|g$" "$SED_SCRIPT" || { echo "missing $k in $ENV_FILE" >&2; exit 1; }
done

mkdir -p "$OUT"
render() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  sed -f "$SED_SCRIPT" "$src" > "$dst"
  # What may stay as a marker: secrets, which are filled on the server by hand.
  if grep -o '@[A-Z_]*@' "$dst" | grep -vE '(PASSWORD|_TOKEN|_KEY|_SECRET|PEPPER|TELEGRAM_CHAT_ID)@$' >/dev/null; then
    echo "unfilled placeholder in $dst:" >&2; grep -n '@[A-Z_]*@' "$dst" >&2; exit 1
  fi
}
for dir in wireguard nftables postgres systemd nginx dns; do
  for f in "$HERE/$dir"/*.template; do
    [ -e "$f" ] || continue
    render "$f" "$OUT/$dir/$(basename "$f" .template)"
  done
done
for f in "$HERE/nginx/bb-proxy.conf" "$HERE/nginx/bb-tls.conf"; do cp "$f" "$OUT/nginx/$(basename "$f")"; done
cp "$HERE/systemd/bb-outbox.timer" "$OUT/systemd/bb-outbox.timer"
for f in "$HERE"/env/*.example; do render "$f" "$OUT/env/$(basename "$f")"; done
echo "rendered to $OUT"
