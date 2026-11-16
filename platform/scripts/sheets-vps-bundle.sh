#!/usr/bin/env bash
# Builds dist-vps/sheets-import-vps.tgz: the importer sources + the pure-JS `pg` driver, nothing else.
# Run on a machine with internet and Node/npm (your Mac). The tarball holds no secrets and no data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
out="dist-vps"; rm -rf "$out"; mkdir -p "$out/bundle/scripts/sql" "$out/bundle/src/core/sheets-import"
cp scripts/sheets-import-dry-run.ts scripts/sheets-ro-role.sh scripts/sheets-vps-run.sh "$out/bundle/scripts/"
cp scripts/sql/sheets-ro-grant.sql "$out/bundle/scripts/sql/"
cp src/core/db.ts src/core/dates.ts src/core/phone.ts src/core/booking-calendar.ts "$out/bundle/src/core/"
cp src/core/sheets-import/*.ts "$out/bundle/src/core/sheets-import/"
pgv="$(node -p "require('./package.json').dependencies.pg")"
printf '{"name":"sheets-import-vps","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$pgv" > "$out/bundle/package.json"
(cd "$out/bundle" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)
chmod +x "$out/bundle/scripts/"*.sh
tar -C "$out" -czf "$out/sheets-import-vps.tgz" bundle
rm -rf "$out/bundle"
echo "built $(pwd)/$out/sheets-import-vps.tgz"
