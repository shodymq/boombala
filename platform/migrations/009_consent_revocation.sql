-- 009_consent_revocation: withdrawal of consent, anonymisation of a contact, and the settings of the retention report.
-- Runs with search_path = bb. Ends with harden_schema().
--
-- Principles (see docs/platform/PRIVACY-LIFECYCLE.md):
--  * Nothing here deletes a contact: other tables point at it (consent history, enquiries, bookings) and the history
--    tables are append-only by design. A contact is ANONYMISED: name and phone are removed, the row stays so that the
--    consent history, enquiries and bookings keep their integrity.
--  * Anonymisation is only for a contact with no active obligation. The database refuses it for a contact that has an
--    active booking or an open enquiry, whatever the application says. Closed enquiries and past bookings are also
--    kept by the application until the retention period for them is decided (legal question, not invented here).
--  * The consent history stays (who accepted which document version, when, how). Only the INDIRECT identifiers on its
--    rows (IP hash, browser string) may be erased, and only for an anonymised contact; nothing else on a row can change.

ALTER TABLE contacts ADD COLUMN anonymized_at timestamptz;

-- The phone may now also be absent after anonymisation (still required for everything else except QR).
ALTER TABLE contacts DROP CONSTRAINT contacts_phone_required_unless_qr;
ALTER TABLE contacts ADD CONSTRAINT contacts_phone_required_unless_qr CHECK (phone_e164 IS NOT NULL OR source = 'qr' OR anonymized_at IS NOT NULL);

CREATE FUNCTION contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.anonymized_at IS NOT NULL THEN
    IF (NEW.name, NEW.name_key, NEW.phone_e164, NEW.source, NEW.marketing_opt_in, NEW.anonymized_at)
       IS DISTINCT FROM (OLD.name, OLD.name_key, OLD.phone_e164, OLD.source, OLD.marketing_opt_in, OLD.anonymized_at) THEN
      RAISE EXCEPTION 'an anonymised contact cannot be changed or restored' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.anonymized_at IS NOT NULL THEN
    IF NEW.phone_e164 IS NOT NULL OR NEW.marketing_opt_in THEN
      RAISE EXCEPTION 'an anonymised contact keeps no phone and no marketing consent' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM slot_reservations r WHERE r.contact_id = OLD.id AND r.released_at IS NULL)
       OR EXISTS (SELECT 1 FROM lead_requests l WHERE l.contact_id = OLD.id AND l.status IN ('new', 'in_progress', 'confirmed')) THEN
      RAISE EXCEPTION 'a contact with an active booking or an open enquiry cannot be anonymised' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_guard_trg BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_guard();

-- Consent history: still no deletes. The only allowed update is erasing the indirect identifiers of an anonymised contact.
DROP TRIGGER consent_events_append_only ON consent_events;
CREATE FUNCTION consent_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_events is append-only (DELETE not allowed)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.contact_id, NEW.document_id, NEW.event, NEW.method, NEW.occurred_at, NEW.lead_request_id, NEW.registration_id, NEW.note, NEW.recorded_by)
     IS DISTINCT FROM
     (OLD.id, OLD.contact_id, OLD.document_id, OLD.event, OLD.method, OLD.occurred_at, OLD.lead_request_id, OLD.registration_id, OLD.note, OLD.recorded_by) THEN
    RAISE EXCEPTION 'consent_events is append-only (only the indirect identifiers may be erased)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.ip_hash IS NOT NULL OR NEW.user_agent IS NOT NULL THEN
    RAISE EXCEPTION 'consent_events may only be erased, never rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = OLD.contact_id AND c.anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'indirect identifiers are erased only for an anonymised contact' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_events_guard_trg BEFORE UPDATE OR DELETE ON consent_events FOR EACH ROW EXECUTE FUNCTION consent_events_guard();

-- The note of a consent event is a CODE, never free text (it is append-only: free text could not be removed later).
ALTER TABLE consent_events ADD CONSTRAINT consent_events_note_code CHECK (note IS NULL OR note IN ('subject_request', 'retention_expired', 'legal_request'));

-- Retention settings: one row. Parameters are set by the Owner; automatic processing cannot be switched on until a
-- legal confirmation is recorded (enforced here, not only in the application). Nothing runs on a schedule.
CREATE TABLE retention_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  qr_months          smallint NOT NULL DEFAULT 12 CHECK (qr_months BETWEEN 1 AND 120),
  auto_enabled       boolean NOT NULL DEFAULT false,
  legal_confirmed_at timestamptz,
  legal_confirmed_by uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT auto_enabled OR legal_confirmed_at IS NOT NULL)
);
INSERT INTO retention_settings DEFAULT VALUES;

SELECT harden_schema();
