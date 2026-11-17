#!/usr/bin/env bash
# Unprivileged side (no sudo, no database admin): reconcile the Google Sheets CSV with production, read-only.
#   ./sheets-vps-run.sh <workdir>/banquets.csv --expect-leads N --expect-bookings N [--expect-blocks N] [--hours HH:MM-HH:MM]
# Needs the credentials the DB admin prepared (sheets-db-admin.sh prepare): <workdir>/ro.url and <workdir>/stage.url.
# This script creates and removes NO database resources. PostgreSQL is reached over the address inside those URLs (127.0.0.1 on
# the VPS), no tunnel, no open port. Production is read inside a READ ONLY transaction after a privilege preflight; the importer's own
# state goes to the separate staging database. stdout/stderr: counts only. Row-level report: <workdir>/reports/ (mode 600, personal data).
# It never creates a booking or a payment fact.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-$(cd "$HERE/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
die() { echo "$*" >&2; exit 2; }
owner_of() { stat -c %U "$1" 2>/dev/null || stat -f %Su "$1"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

CSV="${1:-}"; shift || true
[[ -n "$CSV" && -f "$CSV" ]] || die "usage: $0 <workdir>/banquets.csv --expect-leads N --expect-bookings N [--expect-blocks N] [--hours HH:MM-HH:MM]"
[[ -f "$WORK_DIR/.bb-sheets-workdir" ]] || die "$WORK_DIR is not a prepared workdir (marker missing)"
[[ "$(owner_of "$WORK_DIR")" == "$(id -un)" && "$(mode_of "$WORK_DIR")" == 700 ]] || die "workdir must be owned by you with mode 700"
csv_real="$(cd "$(dirname "$CSV")" && pwd -P)/$(basename "$CSV")"
case "$csv_real" in "$(cd "$WORK_DIR" && pwd -P)"/*) ;; *) die "the CSV must live inside $WORK_DIR" ;; esac
for f in ro.url stage.url; do
  [[ -f "$WORK_DIR/$f" ]] || die "missing $WORK_DIR/$f: the DB admin must run 'sheets-db-admin.sh prepare' first"
  [[ "$(mode_of "$WORK_DIR/$f")" == 600 && "$(owner_of "$WORK_DIR/$f")" == "$(id -un)" ]] || die "$f must be owned by you with mode 600"
done
[[ "$*" == *--expect-leads* && "$*" == *--expect-bookings* ]] || die "--expect-leads and --expect-bookings are required (explicit production counts; bookings = ACTIVE confirmed bookings only, blocks are counted separately)"

ver="$("$NODE_BIN" -p 'process.versions.node')"; major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
flags=(--no-warnings)
if (( major < 22 || (major == 22 && minor < 6) )); then die "Node $ver is too old: need Node 22.6 or newer"; fi
if (( major == 22 && minor < 18 )); then flags+=(--experimental-strip-types); fi

mkdir -p "$WORK_DIR/reports"; chmod 700 "$WORK_DIR/reports"
report="$WORK_DIR/reports/sheets-report-$(date +%Y%m%d-%H%M%S).json"
SHEETS_SPREADSHEET_ID="${SHEETS_SPREADSHEET_ID:-10Xe4jTT6QrRO9ZHRSniT_BPfXHfQgmXkEsNsadZ-13U}" \
READ_URL_FILE="$WORK_DIR/ro.url" STAGING_URL_FILE="$WORK_DIR/stage.url" \
  "$NODE_BIN" "${flags[@]}" "$HERE/sheets-import-dry-run.ts" --csv "$csv_real" --report-file "$report" "$@"
echo "row-level report (personal data, mode 600): $report"
