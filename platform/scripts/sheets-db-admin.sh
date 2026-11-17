#!/usr/bin/env bash
# DB-admin side of the Sheets reconciliation. Run by root (or the postgres OS user). The reconciliation itself runs later as the
# unprivileged owner (e.g. codexops) with sheets-vps-run.sh and needs no sudo.
#
#   sheets-db-admin.sh prepare <owner> <workdir>   create the temporary resources and hand the credentials to <owner>
#   sheets-db-admin.sh cleanup                      remove ONLY what a recorded prepare created
#   sheets-db-admin.sh status
#
# Fail closed: if the role bb_sheets_ro, the role bb_sheets_stage, the database bb_sheet_staging or a policy named
# sheets_ro_select already exists, prepare changes NOTHING and stops. Cleanup works from a manifest of what this tool created
# (with PostgreSQL object ids), so it can never drop a pre-existing or re-created object. A failed prepare removes only what it
# had created so far. Nothing here writes to bb.* data or applies a migration.
#
# Resources prepare creates on the production cluster (infrastructure, not data):
#   role bb_sheets_ro (read-only, 2 connections, valid for TTL_HOURS), SELECT policies "sheets_ro_select" on the needed bb tables
#   and column-level SELECT grants (scripts/sql/sheets-ro-grant.sql); role bb_sheets_stage and database bb_sheet_staging (separate).
#
# Env (optional): PSQL_ADMIN, DB_NAME (default boombala), DB_PORT (5432), HOST_IN_URL (127.0.0.1), TTL_HOURS (12), STATE_DIR, SQL_FILE.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_NAME="${DB_NAME:-boombala}"; DB_PORT="${DB_PORT:-5432}"; HOST_IN_URL="${HOST_IN_URL:-127.0.0.1}"; TTL_HOURS="${TTL_HOURS:-12}"
SQL_FILE="${SQL_FILE:-$HERE/sql/sheets-ro-grant.sql}"
STATE_DIR="${STATE_DIR:-$HOME/.bb-sheets-admin}"
MANIFEST="$STATE_DIR/manifest.env"
RO_ROLE=bb_sheets_ro; STAGE_ROLE=bb_sheets_stage; STAGE_DB=bb_sheet_staging; POLICY=sheets_ro_select
POLICY_TABLES=(rooms packages lead_requests contacts slot_reservations time_slots)
if [[ -z "${PSQL_ADMIN:-}" ]]; then
  if [[ "$(id -u)" == 0 ]]; then PSQL_ADMIN="runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d $DB_NAME"
  else PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d $DB_NAME"; fi
fi
# shellcheck disable=SC2086
admin() { $PSQL_ADMIN "$@"; }
q() { admin -t -A -c "$1"; }                       # one scalar, never echoes data
die() { echo "$*" >&2; exit 2; }
shred_file() { [[ -e "$1" ]] || return 0; if command -v shred >/dev/null 2>&1; then shred -u "$1"; else rm -f "$1"; fi; }
owner_of() { stat -c %U "$1" 2>/dev/null || stat -f %Su "$1"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
rec_oid() { local v; v="$(q "$2")"; [[ -n "$v" ]] || die "could not read the object id of what was just created"; mset "$1" "$v"; }
mset() { printf '%s=%q\n' "$1" "$2" >> "$MANIFEST"; }

do_cleanup() {
  [[ -f "$MANIFEST" ]] || { echo "no manifest at $MANIFEST: nothing recorded, nothing removed (pre-existing objects are never touched)"; return 0; }
  local ro_created=0 ro_oid="" granted=0 stage_role_created=0 stage_role_oid="" stage_db_created=0 stage_db_oid="" ro_url_file="" stage_url_file=""
  # shellcheck disable=SC1090
  . "$MANIFEST"
  local bad=0 now
  if [[ "$ro_created" == 1 ]]; then
    now="$(q "SELECT oid FROM pg_roles WHERE rolname='$RO_ROLE'")"
    if [[ -z "$now" ]]; then echo "$RO_ROLE: already gone"
    elif [[ -n "$ro_oid" && "$now" != "$ro_oid" ]]; then echo "NOT dropping $RO_ROLE: it is not the role this tool created (object id changed)" >&2; bad=1
    else
      q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename='$RO_ROLE'" >/dev/null
      if [[ "$granted" == 1 ]]; then
        local t
        for t in "${POLICY_TABLES[@]}"; do
          # only our own policy: same name AND exactly this role
          if [[ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='bb' AND tablename='$t' AND policyname='$POLICY' AND roles::text='{$RO_ROLE}'")" == 1 ]]; then
            admin -c "DROP POLICY $POLICY ON bb.$t" >/dev/null
          fi
        done
      fi
      admin -c "DROP OWNED BY $RO_ROLE" >/dev/null
      admin -c "DROP ROLE $RO_ROLE" >/dev/null
      echo "$RO_ROLE and its policies/grants removed"
    fi
  fi
  if [[ "$stage_db_created" == 1 ]]; then
    now="$(q "SELECT oid FROM pg_database WHERE datname='$STAGE_DB'")"
    if [[ -z "$now" ]]; then echo "$STAGE_DB: already gone"
    elif [[ -n "$stage_db_oid" && "$now" != "$stage_db_oid" ]]; then echo "NOT dropping database $STAGE_DB: it is not the database this tool created (object id changed)" >&2; bad=1
    else
      q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='$STAGE_DB'" >/dev/null
      admin -c "DROP DATABASE $STAGE_DB" >/dev/null
      echo "database $STAGE_DB removed"
    fi
  fi
  if [[ "$stage_role_created" == 1 ]]; then
    now="$(q "SELECT oid FROM pg_roles WHERE rolname='$STAGE_ROLE'")"
    if [[ -z "$now" ]]; then echo "$STAGE_ROLE: already gone"
    elif [[ -n "$stage_role_oid" && "$now" != "$stage_role_oid" ]]; then echo "NOT dropping $STAGE_ROLE: it is not the role this tool created (object id changed)" >&2; bad=1
    elif [[ "$bad" == 0 ]]; then admin -c "DROP ROLE $STAGE_ROLE" >/dev/null; echo "$STAGE_ROLE removed"
    else echo "$STAGE_ROLE kept because the database could not be removed" >&2; fi
  fi
  [[ -n "$ro_url_file" ]] && shred_file "$ro_url_file"
  [[ -n "$stage_url_file" ]] && shred_file "$stage_url_file"
  if [[ "$bad" == 0 ]]; then rm -f "$MANIFEST"; echo "cleanup complete"; else echo "cleanup INCOMPLETE: manifest kept, resolve manually" >&2; return 1; fi
}

cmd="${1:-}"
case "$cmd" in
  prepare)
    owner="${2:-}"; workdir="${3:-}"
    [[ -n "$owner" && -n "$workdir" ]] || die "usage: $0 prepare <owner-os-user> <workdir>"
    id "$owner" >/dev/null 2>&1 || die "no such user: $owner"
    [[ -d "$workdir" && ! -L "$workdir" ]] || die "workdir $workdir must be an existing directory (created by $owner)"
    [[ "$(owner_of "$workdir")" == "$owner" ]] || die "workdir must be owned by $owner"
    [[ "$(mode_of "$workdir")" == 700 ]] || die "workdir must have mode 700"
    [[ -f "$workdir/.bb-sheets-workdir" ]] || die "workdir has no .bb-sheets-workdir marker (created by sheets-verify-archive.sh)"
    if [[ "$(id -u)" != 0 && "$owner" != "$(id -un)" ]]; then die "run prepare as root to hand credentials to $owner (or as $owner yourself)"; fi
    [[ -f "$SQL_FILE" ]] || die "missing grant SQL: $SQL_FILE"
    [[ ! -e "$MANIFEST" ]] || die "a previous prepare is still recorded ($MANIFEST): run '$0 cleanup' first"
    # --- fail closed on anything that already exists ---
    [[ "$(q "SELECT to_regclass('bb.slot_reservations') IS NOT NULL")" == t ]] || die "schema bb not found in database $DB_NAME"
    exists=""
    [[ "$(q "SELECT count(*) FROM pg_roles WHERE rolname IN ('$RO_ROLE','$STAGE_ROLE')")" == 0 ]] || exists+=" role($RO_ROLE|$STAGE_ROLE)"
    [[ "$(q "SELECT count(*) FROM pg_database WHERE datname='$STAGE_DB'")" == 0 ]] || exists+=" database($STAGE_DB)"
    [[ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='bb' AND policyname='$POLICY'")" == 0 ]] || exists+=" policy($POLICY)"
    [[ -z "$exists" ]] || die "REFUSING: already exists:$exists. Nothing was changed. Resolve them yourself (they are not ours to remove)."
    mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
    : > "$MANIFEST"; mset workdir "$workdir"; mset owner "$owner"
    PREP_ACTIVE=1
    trap 'rc=$?; if [[ $rc -ne 0 && "${PREP_ACTIVE:-0}" == 1 ]]; then echo "prepare failed: removing only what this run created" >&2; do_cleanup || true; fi' EXIT
    # --- read-only login role ---
    mset ro_created 1
    pw="$(openssl rand -hex 24)"
    { printf "SET password_encryption = 'scram-sha-256';\n"
      printf "CREATE ROLE %s LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '%s';\n" "$RO_ROLE" "$pw"
      printf "ALTER ROLE %s SET default_transaction_read_only = on;\n" "$RO_ROLE"
      printf "ALTER ROLE %s SET statement_timeout = '30s';\n" "$RO_ROLE"
      printf "ALTER ROLE %s SET idle_in_transaction_session_timeout = '30s';\n" "$RO_ROLE"
      # VALID UNTIL only blocks NEW logins; the explicit cleanup is what drops the role and ends sessions.
      printf "DO \$r\$ BEGIN EXECUTE format('ALTER ROLE %s VALID UNTIL %%L', (now() + interval '%s hours')::text); END \$r\$;\n" "$RO_ROLE" "$TTL_HOURS"
    } | admin >/dev/null
    rec_oid ro_oid "SELECT oid FROM pg_roles WHERE rolname='$RO_ROLE'"
    mset granted 1
    admin < "$SQL_FILE" >/dev/null   # via stdin: the postgres OS user may not be able to read root's files
    # --- separate staging database ---
    mset stage_role_created 1
    spw="$(openssl rand -hex 24)"
    { printf "SET password_encryption = 'scram-sha-256';\n"
      printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '%s';\n" "$STAGE_ROLE" "$spw"; } | admin >/dev/null
    rec_oid stage_role_oid "SELECT oid FROM pg_roles WHERE rolname='$STAGE_ROLE'"
    mset stage_db_created 1
    admin -c "CREATE DATABASE $STAGE_DB OWNER $STAGE_ROLE TEMPLATE template0" >/dev/null
    rec_oid stage_db_oid "SELECT oid FROM pg_database WHERE datname='$STAGE_DB'"
    admin -c "REVOKE ALL ON DATABASE $STAGE_DB FROM PUBLIC" >/dev/null
    # --- hand the credentials to the owner: mode-600 files in the owner's workdir ---
    for pair in "ro:$RO_ROLE:$pw:$DB_NAME" "stage:$STAGE_ROLE:$spw:$STAGE_DB"; do
      IFS=: read -r tag user pass db <<< "$pair"
      f="$workdir/$tag.url"
      mset "${tag}_url_file" "$f"
      ( umask 077; printf 'postgres://%s:%s@%s:%s/%s\n' "$user" "$pass" "$HOST_IN_URL" "$DB_PORT" "$db" > "$f" )
      [[ "$(id -u)" != 0 ]] || chown "$owner" "$f"
      chmod 600 "$f"
    done
    unset pw spw pass
    PREP_ACTIVE=0
    echo "prepared (no secret printed): role $RO_ROLE (read-only, new logins valid ${TTL_HOURS}h), policies $POLICY, database $STAGE_DB + role $STAGE_ROLE."
    echo "credentials: $workdir/ro.url and $workdir/stage.url (mode 600, owner $owner). Manifest: $MANIFEST"
    echo "next: $owner runs sheets-vps-run.sh; afterwards run '$0 cleanup' here."
    ;;
  cleanup) do_cleanup ;;
  status)
    echo "manifest: $([[ -f "$MANIFEST" ]] && echo present || echo absent)"
    for r in "$RO_ROLE" "$STAGE_ROLE"; do echo "role $r: $([[ "$(q "SELECT count(*) FROM pg_roles WHERE rolname='$r'")" == 0 ]] && echo absent || echo present)"; done
    echo "database $STAGE_DB: $([[ "$(q "SELECT count(*) FROM pg_database WHERE datname='$STAGE_DB'")" == 0 ]] && echo absent || echo present)"
    echo "policies $POLICY: $(q "SELECT count(*) FROM pg_policies WHERE schemaname='bb' AND policyname='$POLICY'")"
    ;;
  *) echo "usage: $0 prepare <owner> <workdir> | cleanup | status" >&2; exit 2 ;;
esac
