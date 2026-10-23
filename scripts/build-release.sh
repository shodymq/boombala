#!/usr/bin/env bash
# Builds the deployable artifact for the Kazakhstan server from a COMMITTED state of the repository.
#
#   PUBLIC_SITE_URL=https://example.kz scripts/build-release.sh [git-ref]        (default ref: HEAD)
#
# Run it on Linux x86_64 (the CI workflow does: ubuntu-24.04), NEVER on the VPS and not on a Mac: the production dependencies include
# native modules (sharp, @node-rs/argon2) that must be the Linux x64 builds. ALLOW_NON_LINUX=1 allows a dry run of the packaging on
# another machine; such an artifact must not be deployed. Output: dist/boombala-<sha>-linux-x64.tar.gz, its .sha256 and RELEASE.json.
#
# Layout of the archive (extract it into /opt/boombala/releases/<sha>/ and point /opt/boombala/site and /opt/boombala/platform at the
# two directories; the systemd units run `node node_modules/next/dist/bin/next start` inside them):
#   site/       built public site: .next, public, node_modules (production only), package.json, next.config.ts
#   platform/   built staff/API application (the same build runs as role api and as role admin), plus migrations/, scripts/, src/
#               (the migration, role, preflight, seed, legal-load and export tools run from here: `node --no-warnings scripts/<tool>.ts`)
#   src/data/   the catalogue files the seed reads (platform/scripts/seed.ts imports ../../src/data)
#   RELEASE.json
# NEXT_PUBLIC_* values are inlined into the browser code at build time, so they are inputs of THIS build, not of the server's env files.
set -euo pipefail

REF="${1:-HEAD}"
: "${PUBLIC_SITE_URL:?PUBLIC_SITE_URL is required, e.g. https://boombala.kz (it is inlined into the build)}"
case "$PUBLIC_SITE_URL" in https://*) ;; *) echo "PUBLIC_SITE_URL must start with https://" >&2; exit 2 ;; esac
if [ "${ALLOW_NON_LINUX:-0}" != "1" ] && { [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; }; then
  echo "refusing to build: this must run on Linux x86_64 (found $(uname -s) $(uname -m))" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse --short=12 "$REF")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src" "$ROOT/dist"
git -C "$ROOT" archive "$REF" | tar -x -C "$WORK/src"

echo "== site build ($SHA)"
(
  cd "$WORK/src"
  npm ci --no-audit --no-fund
  NEXT_PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
  NEXT_PUBLIC_SITE_PROFILE=kz-production \
  NEXT_PUBLIC_BOOKING_CALENDAR="${BOOKING_CALENDAR:-0}" \
  NEXT_PUBLIC_NEWS="${NEWS:-0}" \
  npm run build
  npm prune --omit=dev --no-audit --no-fund
)
echo "== platform build"
(
  cd "$WORK/src/platform"
  npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
)

echo "== assemble"
OUT="$WORK/out"
mkdir -p "$OUT/site" "$OUT/platform" "$OUT/src"
S="$WORK/src"
cp -R "$S/.next" "$S/public" "$S/node_modules" "$S/package.json" "$S/package-lock.json" "$S/next.config.ts" "$OUT/site/"
rm -rf "$OUT/site/.next/cache" "$OUT/site/.next/dev"
P="$S/platform"
cp -R "$P/.next" "$P/node_modules" "$P/migrations" "$P/scripts" "$P/src" "$P/package.json" "$P/package-lock.json" "$P/next.config.ts" "$OUT/platform/"
rm -rf "$OUT/platform/.next/cache" "$OUT/platform/.next/dev"
cp -R "$S/src/data" "$OUT/src/data"

NODE_V="$(node -v)"
cat > "$OUT/RELEASE.json" <<JSON
{"commit":"$(git -C "$ROOT" rev-parse "$REF")","built_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","node_build":"$NODE_V","platform":"$(uname -s)-$(uname -m)","public_site_url":"$PUBLIC_SITE_URL","booking_calendar":"${BOOKING_CALENDAR:-0}","news":"${NEWS:-0}","site_profile":"kz-production"}
JSON

if [ "${SMOKE:-1}" = "1" ]; then
  echo "== smoke: both applications start from the archive layout (no database, no secrets)"
  smoke() { # dir port path
    ( cd "$1" && NODE_ENV=production node node_modules/next/dist/bin/next start -p "$2" -H 127.0.0.1 >"$WORK/smoke-$2.log" 2>&1 & echo $! >"$WORK/smoke-$2.pid" )
    for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$2$3" && break; sleep 0.5; done
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$2$3" || true)"
    kill "$(cat "$WORK/smoke-$2.pid")" 2>/dev/null || true
    echo "$3 -> $code"
    [ "$code" != "000" ] || { echo "the application did not start:"; tail -20 "$WORK/smoke-$2.log"; exit 1; }
    echo "$code"
  }
  site_code="$(smoke "$OUT/site" 3491 / | tail -1)"
  [ "$site_code" = "200" ] || { echo "site smoke failed ($site_code)" >&2; exit 1; }
  # the staff application answers 503/404 without its environment: any HTTP answer proves it starts
  smoke "$OUT/platform" 3492 /api/health >/dev/null
fi

NAME="boombala-${SHA}-linux-x64"
tar -C "$WORK" -czf "$ROOT/dist/$NAME.tar.gz" --transform "s,^out,boombala-release," out 2>/dev/null || {
  # bsdtar (macOS) has no --transform: rename the directory instead
  mv "$OUT" "$WORK/boombala-release"
  tar -C "$WORK" -czf "$ROOT/dist/$NAME.tar.gz" boombala-release
}
cp "$WORK/out/RELEASE.json" "$ROOT/dist/RELEASE.json" 2>/dev/null || cp "$WORK/boombala-release/RELEASE.json" "$ROOT/dist/RELEASE.json"
( cd "$ROOT/dist" && { sha256sum "$NAME.tar.gz" 2>/dev/null || shasum -a 256 "$NAME.tar.gz"; } > "$NAME.tar.gz.sha256" )
echo "== done: dist/$NAME.tar.gz ($(du -h "$ROOT/dist/$NAME.tar.gz" | cut -f1))"
