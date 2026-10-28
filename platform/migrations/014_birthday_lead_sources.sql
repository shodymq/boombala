-- 014_birthday_lead_sources: birthday enquiries from the mobile app, idempotent by (source, external_request_id),
-- and the moment a status last changed. Runs with search_path = bb. Ends with harden_schema().
--
-- Principles:
--  * Append-only: migrations 001-013 are not edited. Existing enquiries keep their status vocabulary (004_crm); no status
--    value is added here.
--  * Every existing enquiry is a birthday_form enquiry (the public site). Only the mobile source carries an external id.
--  * The public API role reaches the new rows only through the intake_* SECURITY DEFINER functions below.

ALTER TABLE lead_requests
  ADD COLUMN source text NOT NULL DEFAULT 'birthday_form' CHECK (source IN ('birthday_form', 'mobile_app')),
  ADD COLUMN external_request_id uuid,
  ADD COLUMN request_fingerprint text CHECK (request_fingerprint IS NULL OR length(request_fingerprint) = 64),
  ADD COLUMN status_changed_at timestamptz;

-- Existing rows: the last change is unknown, the creation time is the honest value.
UPDATE lead_requests SET status_changed_at = created_at;
ALTER TABLE lead_requests ALTER COLUMN status_changed_at SET DEFAULT now(), ALTER COLUMN status_changed_at SET NOT NULL;

-- A mobile enquiry must name the client's request id; a site enquiry must not.
ALTER TABLE lead_requests ADD CONSTRAINT lead_requests_external_id_by_source CHECK (
  (source = 'mobile_app') = (external_request_id IS NOT NULL)
);
-- One enquiry per client request id per source. Partial, so site rows (NULL) are not affected.
CREATE UNIQUE INDEX lead_requests_source_external_uq ON lead_requests (source, external_request_id)
  WHERE external_request_id IS NOT NULL;

-- The moment of the last status change, set by the database itself (not by the application).
CREATE FUNCTION lead_requests_status_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_requests_status_clock_trg BEFORE UPDATE OF status ON lead_requests
  FOR EACH ROW EXECUTE FUNCTION lead_requests_status_clock();

-- ── Functions for the public API role (granted by scripts/db-roles.ts: every bb.intake_* function) ─────────────────

-- Lookup for idempotency: one row for (source, external id), or none.
CREATE FUNCTION intake_find_external_lead(p_source text, p_external uuid) RETURNS TABLE (id uuid, seq bigint, fingerprint text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  SELECT l.id, l.seq, l.request_fingerprint FROM bb.lead_requests l
   WHERE l.source = p_source AND l.external_request_id = p_external
$$;

-- Creates a mobile enquiry. The internal idempotency_key is generated here, so a client-chosen uuid can never collide
-- with a site key. On a race the conflicting insert does nothing and returns no row; the caller then reads the winner.
CREATE FUNCTION intake_insert_external_lead(
  p_source text, p_external uuid, p_fingerprint text, p_contact uuid, p_package text, p_room text, p_date date, p_children smallint,
  p_page text, p_referrer text, p_utm_source text, p_utm_medium text, p_utm_campaign text, p_slot smallint
) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
BEGIN
  IF p_source <> 'mobile_app' THEN
    RAISE EXCEPTION 'external enquiries are created for the mobile source only' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  INSERT INTO bb.lead_requests (source, external_request_id, request_fingerprint, idempotency_key, contact_id, package_id, room_id,
                                requested_date, children, page, referrer, utm_source, utm_medium, utm_campaign, slot_id)
  VALUES (p_source, p_external, p_fingerprint, gen_random_uuid(), p_contact, p_package, p_room,
          p_date, p_children, p_page, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_slot)
  ON CONFLICT (source, external_request_id) WHERE external_request_id IS NOT NULL DO NOTHING
  RETURNING lead_requests.id, lead_requests.seq;
END $$;

-- Read-only status of one enquiry, found only by its source and client request id. Returns the status and the time of the
-- last change, nothing else: no personal data.
CREATE FUNCTION intake_lead_status(p_source text, p_external uuid) RETURNS TABLE (status text, status_changed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  SELECT l.status, l.status_changed_at FROM bb.lead_requests l
   WHERE l.source = p_source AND l.external_request_id = p_external
$$;

SELECT harden_schema();
