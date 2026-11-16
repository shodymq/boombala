-- Column-level, version-aware read-only grants for role bb_sheets_ro. The role must already exist (the password is set by
-- scripts/sheets-ro-role.sh, never here). Idempotent. Works on the pre-015 schema (slot_date + slot_id + time_slots) and on
-- post-015 (exact starts_at). It never applies a migration and never grants a payment, comment or contact-detail column.
-- Keep the column lists in step with REQUIRED_COLUMNS in src/core/sheets-import/importer.ts (a test enforces it).
DO $grant$
DECLARE post015 boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_sheets_ro') THEN
    RAISE EXCEPTION 'role bb_sheets_ro does not exist';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'bb.slot_reservations'::regclass AND attname = 'starts_at' AND NOT attisdropped) INTO post015;

  -- Every bb table has RLS enabled with NO policies (migration 003): without BYPASSRLS a non-owner role silently sees ZERO rows,
  -- which would look like "nothing in the CRM". BYPASSRLS only lifts row filtering; the column-level grants below still limit
  -- what can be read, and the role cannot write anywhere. Needs a superuser admin; dropped together with the role.
  EXECUTE 'ALTER ROLE bb_sheets_ro BYPASSRLS';
  EXECUTE 'REVOKE ALL ON SCHEMA bb FROM bb_sheets_ro';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA bb FROM bb_sheets_ro';
  EXECUTE 'GRANT USAGE ON SCHEMA bb TO bb_sheets_ro';
  EXECUTE 'GRANT SELECT (id, name, is_active, sort_order) ON bb.rooms TO bb_sheets_ro';
  EXECUTE 'GRANT SELECT (id, name, is_active, sort_order) ON bb.packages TO bb_sheets_ro';
  EXECUTE 'GRANT SELECT (id, contact_id, requested_date, children, package_id, room_id, status) ON bb.lead_requests TO bb_sheets_ro';
  EXECUTE 'GRANT SELECT (id, phone_e164, name_key) ON bb.contacts TO bb_sheets_ro';
  IF post015 THEN
    EXECUTE 'GRANT SELECT (id, kind, room_id, contact_id, starts_at, released_at, children, package_id) ON bb.slot_reservations TO bb_sheets_ro';
  ELSE
    EXECUTE 'GRANT SELECT (id, kind, room_id, contact_id, slot_date, slot_id, released_at, children, package_id) ON bb.slot_reservations TO bb_sheets_ro';
    EXECUTE 'GRANT SELECT (id, starts_at) ON bb.time_slots TO bb_sheets_ro';
  END IF;
END
$grant$;
