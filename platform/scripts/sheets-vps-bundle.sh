#!/usr/bin/env bash
# Builds dist-vps/sheets-import-vps.tgz: the importer sources + the pure-JS `pg` driver, nothing else.
# Run on a machine with internet and Node/npm (your Mac). The tarball holds no secrets and no data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
out="dist-vps"; rm -rf "$out"; mkdir -p "$out/bundle/scripts/sql" "$out/bundle/src/core/sheets-import"
cp scripts/sheets-import-dry-run.ts scripts/sheets-db-admin.sh scripts/sheets-vps-run.sh scripts/sheets-wipe.sh scripts/sheets-verify-archive.sh "$out/bundle/scripts/"
cp scripts/sql/sheets-ro-grant.sql "$out/bundle/scripts/sql/"
cp src/core/db.ts src/core/dates.ts src/core/phone.ts src/core/booking-calendar.ts "$out/bundle/src/core/"
cp src/core/sheets-import/*.ts "$out/bundle/src/core/sheets-import/"
pgv="$(node -p "require('./package.json').dependencies.pg")"
printf '{"name":"sheets-import-vps","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$pgv" > "$out/bundle/package.json"
(cd "$out/bundle" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)
chmod +x "$out/bundle/scripts/"*.sh
tar -C "$out" -czf "$out/sheets-import-vps.tgz" bundle
# Checksums the operator compares with the values reported in chat (a different channel from the files themselves).
cp "$out/bundle/scripts/sheets-verify-archive.sh" "$out/sheets-verify-archive.sh"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
{ echo "$(sha "$out/sheets-import-vps.tgz")  sheets-import-vps.tgz"
  echo "$(sha "$out/sheets-verify-archive.sh")  sheets-verify-archive.sh"
  echo "$(sha "$out/bundle/scripts/sheets-db-admin.sh")  bundle/scripts/sheets-db-admin.sh"
  echo "$(sha "$out/bundle/scripts/sql/sheets-ro-grant.sql")  bundle/scripts/sql/sheets-ro-grant.sql"
} > "$out/SHA256SUMS"
rm -rf "$out/bundle"
echo "built $(pwd)/$out"; cat "$out/SHA256SUMS"
