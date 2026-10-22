-- 013_attendance: the number of children in a QR registration, and the record of children who ACTUALLY came in.
-- Runs with search_path = bb. Ends with harden_schema().
--
-- Principles:
--  * A QR registration is a declaration, never a visit. A visit is a row in attendance_entries, written only by a member of
--    staff (confirmation of a QR registration, or a manual entry for a visitor without QR).
--  * Only a COUNT of children is kept. No names, no ID numbers, no birth dates of children exist anywhere in this schema.
--  * Old registrations keep children_count NULL: nobody declared a number, none is invented.
--  * A QR registration can be confirmed once (unique index), however many staff press the button and however often a request
--    is repeated. A manual entry carries an idempotency key for the same reason.
--  * A confirmed count can be corrected, never silently: the database itself writes a correction row (old, new, reason, who,
--    when) for EVERY change of the count, and refuses any other change of an entry. Entries and corrections are never deleted.
--  * The calendar day of an entry is the day in Asia/Almaty, computed by the database from the moment of entry.

-- ── the declared number of children ─────────────────────────────────────────────────────────────────────────
ALTER TABLE consent_registrations ADD COLUMN children_count smallint CHECK (children_count BETWEEN 1 AND 50);
-- NOT VALID: every NEW registration must carry the number; existing rows (NULL) are not touched and not invented.
ALTER TABLE consent_registrations ADD CONSTRAINT consent_registrations_children_required CHECK (children_count IS NOT NULL) NOT VALID;

-- The public API may create a registration only together with the number (1..50), through the same narrow function as before.
-- The old two-argument function would create a registration without it, so it is replaced, not kept next to the new one.
DROP FUNCTION intake_insert_registration(uuid, uuid);
CREATE FUNCTION intake_insert_registration(p_key uuid, p_contact uuid, p_children smallint) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count) VALUES (p_key, p_contact, p_children)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING consent_registrations.id, consent_registrations.seq
$$;

-- ── actual entries ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE attendance_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  registration_id uuid REFERENCES consent_registrations(id),
  method          text NOT NULL CHECK (method IN ('qr', 'manual')),
  -- 0 means "cancelled by a correction"; a new entry always has at least one child (see the check below)
  children_count  smallint NOT NULL CHECK (children_count BETWEEN 0 AND 50),
  entered_at      timestamptz NOT NULL DEFAULT now(),
  entry_date      date NOT NULL GENERATED ALWAYS AS ((entered_at AT TIME ZONE 'Asia/Almaty')::date) STORED,
  confirmed_by    uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_method_matches_registration CHECK ((method = 'qr') = (registration_id IS NOT NULL))
);
-- One confirmation per registration, enforced by PostgreSQL: concurrent confirmations cannot both win.
CREATE UNIQUE INDEX attendance_entries_registration_uq ON attendance_entries (registration_id) WHERE registration_id IS NOT NULL;
CREATE INDEX attendance_entries_date_idx ON attendance_entries (entry_date);

CREATE TABLE attendance_corrections (
  id           bigserial PRIMARY KEY,
  entry_id     uuid NOT NULL REFERENCES attendance_entries(id),
  old_count    smallint NOT NULL CHECK (old_count BETWEEN 0 AND 50),
  new_count    smallint NOT NULL CHECK (new_count BETWEEN 0 AND 50),
  -- a CODE, never free text: this table is append-only, free text could not be removed later
  reason       text NOT NULL CHECK (reason IN ('miscount', 'late_arrivals', 'wrong_registration', 'duplicate', 'other')),
  corrected_by uuid NOT NULL REFERENCES users(id),
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CHECK (old_count <> new_count)
);
CREATE INDEX attendance_corrections_entry_idx ON attendance_corrections (entry_id, id);
CREATE TRIGGER attendance_corrections_append_only BEFORE UPDATE OR DELETE ON attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER attendance_corrections_no_truncate BEFORE TRUNCATE ON attendance_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Guard of entries. INSERT: a new entry counts at least one child. UPDATE: only the count may change, and every change writes
-- its correction row here, from the actor and the reason the application put into the transaction (SET LOCAL via set_config).
-- DELETE and TRUNCATE are refused.
CREATE FUNCTION attendance_entries_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
DECLARE
  who uuid;
  why text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.children_count < 1 THEN
      RAISE EXCEPTION 'an entry counts at least one child' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'attendance_entries is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.seq, NEW.registration_id, NEW.method, NEW.entered_at, NEW.confirmed_by, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.seq, OLD.registration_id, OLD.method, OLD.entered_at, OLD.confirmed_by, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'only the number of children of an entry can be corrected' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.children_count IS DISTINCT FROM OLD.children_count THEN
    BEGIN
      who := nullif(current_setting('bb.actor', true), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      who := NULL;
    END;
    why := nullif(current_setting('bb.reason', true), '');
    IF who IS NULL OR why IS NULL THEN
      RAISE EXCEPTION 'a correction needs the person and the reason' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    INSERT INTO bb.attendance_corrections (entry_id, old_count, new_count, reason, corrected_by) VALUES (OLD.id, OLD.children_count, NEW.children_count, why, who);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_entries_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON attendance_entries
  FOR EACH ROW EXECUTE FUNCTION attendance_entries_guard();
CREATE TRIGGER attendance_entries_no_truncate BEFORE TRUNCATE ON attendance_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

SELECT harden_schema();
