#!/usr/bin/env bash
# Removes the reconciliation workdir: the CSV, reports, the extracted bundle, the archive and the leftover files — and ONLY those.
# Run it AFTER the DB admin ran 'sheets-db-admin.sh cleanup' (that removes the staging database and the credentials).
#   ./sheets-wipe.sh [workdir]
# Safety: the workdir must carry the .bb-sheets-workdir marker, be owned by you, and may not be a symlink. Only known names are
# deleted; the final rmdir fails (and keeps everything unknown) if anything else is inside. No wildcards outside the workdir.
set -euo pipefail
main() {
  local work="${1:-${WORK_DIR:-}}"
  [[ -n "$work" ]] || { echo "usage: $0 <workdir>" >&2; return 2; }
  [[ -d "$work" && ! -L "$work" && -f "$work/.bb-sheets-workdir" ]] || { echo "$work is not a reconciliation workdir (marker missing): nothing removed" >&2; return 2; }
  [[ "$( (stat -c %U "$work" 2>/dev/null || stat -f %Su "$work") )" == "$(id -un)" ]] || { echo "workdir is not owned by you: nothing removed" >&2; return 2; }
  if [[ -e "$work/ro.url" || -e "$work/stage.url" ]] && [[ "${FORCE_CREDENTIALS:-}" != yes ]]; then
    echo "credential files are still present: the DB admin has not run 'sheets-db-admin.sh cleanup' yet (the staging database holds personal data). Nothing removed." >&2; return 2
  fi
  local shredder="rm -f"; command -v shred >/dev/null 2>&1 && shredder="shred -u"
  local f
  for f in "$work"/*.csv "$work"/reports/*.json "$work"/ro.url "$work"/stage.url "$work"/sheets-import-vps.tgz "$work"/SHA256SUMS "$work"/sheets-verify-archive.sh; do
    [[ -f "$f" && ! -L "$f" ]] && $shredder "$f"
  done
  [[ -d "$work/reports" ]] && rmdir "$work/reports"
  [[ -d "$work/bundle" && ! -L "$work/bundle" ]] && rm -rf "$work/bundle"
  rm -f "$work/.bb-sheets-workdir"
  if rmdir "$work" 2>/dev/null; then echo "workdir removed"; else echo "workdir kept: it still contains files that are not part of this reconciliation (listed below)" >&2; ls -A "$work" >&2; return 1; fi
}
main "$@"; exit $?
