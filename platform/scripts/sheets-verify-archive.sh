#!/usr/bin/env bash
# Verifies the archive BEFORE anything is extracted, then extracts it into ./bundle of the current (new, owner-only) directory.
#   cd ~/sheets-recon && bash sheets-verify-archive.sh sheets-import-vps.tgz <expected-sha256>
# 1. the SHA-256 must equal the value you were given through a different channel (the chat), not the one in a file next to it;
# 2. every entry must be a plain file or directory under bundle/ (no absolute path, no '..', no symlink, hardlink or device);
# 3. only the expected tree is allowed: package files, scripts/, src/core/, node_modules/;
# 4. ./bundle must not exist (nothing is overwritten). Entries are listed by name only, no content is shown.
set -euo pipefail
archive="${1:-}"; want="${2:-}"
die() { echo "REJECTED: $*" >&2; exit 1; }
[[ -f "$archive" && ! -L "$archive" ]] || die "archive not found"
[[ "$want" =~ ^[0-9a-fA-F]{64}$ ]] || die "second argument must be the expected SHA-256 (64 hex characters)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$archive" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$archive" | cut -d' ' -f1)"; fi
[[ "$(echo "$got" | tr A-F a-f)" == "$(echo "$want" | tr A-F a-f)" ]] || die "SHA-256 mismatch (got $got)"
size="$(wc -c < "$archive")"; (( size < 52428800 )) || die "archive larger than 50 MB"
mode="$(stat -c %a . 2>/dev/null || stat -f %Lp .)"; [[ "$mode" == 700 ]] || die "run this inside a directory with mode 700 that only you can use (chmod 700 .)"
[[ ! -e bundle ]] || die "./bundle already exists: it is not overwritten (use a fresh directory)"
names="$(tar -tzf "$archive")" || die "not a readable gzip tar"
verbose="$(tar -tvzf "$archive")"
bad="$(echo "$verbose" | cut -c1 | grep -v '^[-d]$' || true)"; [[ -z "$bad" ]] || die "contains links, devices or other special entries"
while IFS= read -r n; do
  [[ -n "$n" ]] || continue
  [[ "$n" != /* && "$n" != *\\* ]] || die "unsafe path: $n"
  case "/$n/" in */../*) die "unsafe path: $n" ;; esac
  case "$n" in
    bundle|bundle/|bundle/package.json|bundle/package-lock.json|bundle/scripts/|bundle/scripts/*|bundle/src/|bundle/src/core/|bundle/src/core/*|bundle/node_modules/|bundle/node_modules/*) ;;
    *) die "unexpected entry: $n" ;;
  esac
done <<< "$names"
echo "archive OK: sha256 matches; $(echo "$names" | wc -l | tr -d ' ') entries, none unsafe."
echo "files outside node_modules:"; echo "$names" | grep -v '/node_modules/' | grep -v '/$' | sed 's/^/  /'
echo "node_modules entries: $(echo "$names" | grep -c '/node_modules/' || true)"
touch .bb-sheets-workdir
tar --no-same-owner --no-same-permissions -xzf "$archive" -C .
echo "extracted into $(pwd)/bundle"
