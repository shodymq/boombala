#!/usr/bin/env bash
# One command on the VPS: reconcile the Google Sheets CSV with production, then remove the temporary access.
#   ./sheets-vps-run.sh banquets.csv [--hours 10:00-23:00] [--expect-leads N] [--expect-reservations N]
# Everything stays on this machine: PostgreSQL is reached over 127.0.0.1 (no tunnel, no open port, no sshd change).
# 1. prepares a SEPARATE staging database (bb_sheet_staging) with its own role (no access to bb.*), once;
# 2. creates the temporary read-only role bb_sheets_ro, whose URL lives only in a mode-600 temp file;
# 3. runs the dry run: production is read inside a READ ONLY transaction, after a privilege preflight;
# 4. revokes the role and deletes the temp URL file, also when the run fails (trap).
# stdout/stderr: aggregate counts only. Row-level report: $REPORT_DIR/sheets-report-<time>.json (mode 600, contains personal data, stays here).
# It never writes to bb.*, never creates a booking or a payment fact.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV="${1:-}"; shift || true
[[ -n "$CSV" && -f "$CSV" ]] || { echo "usage: $0 <banquets.csv> [--hours HH:MM-HH:MM] [--expect-leads N] [--expect-reservations N]" >&2; exit 2; }
NODE_BIN="${NODE_BIN:-node}"
REPORT_DIR="${REPORT_DIR:-$HOME}"
export TUNNEL_PORT="${DB_PORT:-5432}" HOST_IN_URL="${HOST_IN_URL:-127.0.0.1}"

ver="$("$NODE_BIN" -p 'process.versions.node')"; major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
flags=(--no-warnings)
if (( major < 22 || (major == 22 && minor < 6) )); then echo "Node $ver is too old: need Node 22.6 or newer" >&2; exit 2; fi
if (( major == 22 && minor < 18 )); then flags+=(--experimental-strip-types); fi

tmp="$(mktemp -d)"; chmod 700 "$tmp"
export URL_FILE="$tmp/ro.url"
cleanup() {
  bash "$HERE/sheets-ro-role.sh" revoke >/dev/null 2>&1 && echo "temporary read-only role revoked" || echo "WARNING: could not revoke bb_sheets_ro: run '$HERE/sheets-ro-role.sh revoke' (it also expires by itself)" >&2
  rm -rf "$tmp"
}
trap cleanup EXIT

bash "$HERE/sheets-ro-role.sh" stage-create
TTL_HOURS="${TTL_HOURS:-2}" bash "$HERE/sheets-ro-role.sh" create
STAGE_URL_FILE="${STAGE_URL_FILE:-$HOME/.bb_sheets_stage.url}"
report="$REPORT_DIR/sheets-report-$(date +%Y%m%d-%H%M%S).json"
SHEETS_SPREADSHEET_ID="${SHEETS_SPREADSHEET_ID:-10Xe4jTT6QrRO9ZHRSniT_BPfXHfQgmXkEsNsadZ-13U}" \
READ_URL_FILE="$URL_FILE" STAGING_URL_FILE="$STAGE_URL_FILE" \
  "$NODE_BIN" "${flags[@]}" "$HERE/sheets-import-dry-run.ts" --csv "$CSV" --report-file "$report" "$@"
echo "row-level report (personal data, mode 600): $report"
