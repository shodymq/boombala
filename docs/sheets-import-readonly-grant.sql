-- Minimal read-only role for the Google Sheets reconciliation (PR #52).
-- Run once by the DB owner on production. Review before running. Nothing here writes data.
-- Password: generate it yourself (e.g. `openssl rand -base64 32`) and pass it via psql variable, never commit it:
--   psql "$ADMIN_URL" -v pw="$(openssl rand -base64 32)" -f sheets-import-readonly-grant.sql
-- Then give READ_URL (with that role) to the dry-run through the environment only.

CREATE ROLE bb_sheets_ro LOGIN PASSWORD :'pw' NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER CONNECTION LIMIT 2;
ALTER ROLE bb_sheets_ro SET default_transaction_read_only = on;
ALTER ROLE bb_sheets_ro SET statement_timeout = '30s';

REVOKE ALL ON SCHEMA bb FROM bb_sheets_ro;
GRANT USAGE ON SCHEMA bb TO bb_sheets_ro;

-- Catalog (no personal data).
GRANT SELECT (id, name, is_active, sort_order) ON bb.rooms TO bb_sheets_ro;
GRANT SELECT (id, name, is_active, sort_order) ON bb.packages TO bb_sheets_ro;

-- Requests: only the columns the matcher reads. No payment, comment or contact-detail columns.
GRANT SELECT (id, contact_id, requested_date, children, package_id, room_id, status) ON bb.lead_requests TO bb_sheets_ro;

-- Contacts: normalized phone and name key are needed to match; no other contact fields.
GRANT SELECT (id, phone_e164, name_key) ON bb.contacts TO bb_sheets_ro;

-- Reservations: interval, room and status only. No payment columns.
GRANT SELECT (id, kind, room_id, contact_id, starts_at, released_at, children, package_id) ON bb.slot_reservations TO bb_sheets_ro;

-- Revoke afterwards: DROP OWNED BY bb_sheets_ro; DROP ROLE bb_sheets_ro;
