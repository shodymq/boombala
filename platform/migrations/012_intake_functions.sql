-- 012_intake_functions: the ONLY way the public API touches personal data.
-- Runs with search_path = bb. Ends with harden_schema().
--
-- The public API role gets no table privileges on contacts, enquiries, consent history, registrations, the notification
-- queue or the audit log. It may execute exactly these functions. Each does one narrow thing, returns at most ONE row,
-- and takes the unguessable idempotency key (or an id the caller just received) as its handle: there is no way to list,
-- scan or search. They run as their owner (SECURITY DEFINER, fixed search_path) and bypass row security by that.
--
-- What a compromised API process can still learn: whether an exact (name, phone) pair already exists (the id returned by
-- intake_upsert_contact). It cannot read a name or a phone, and cannot enumerate contacts.

CREATE FUNCTION intake_upsert_contact(p_name text, p_name_key text, p_phone text, p_source text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
DECLARE cid uuid;
BEGIN
  IF p_source NOT IN ('qr', 'birthday_form') THEN
    RAISE EXCEPTION 'unknown intake source' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_phone IS NULL THEN
    -- No phone, no identity: never merged by name, each registration is its own contact (see 008).
    INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES (p_name, p_name_key, NULL, p_source) RETURNING id INTO cid;
  ELSE
    INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES (p_name, p_name_key, p_phone, p_source)
    ON CONFLICT (phone_e164, name_key) DO UPDATE SET last_activity_at = now()
    RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$;

CREATE FUNCTION intake_find_lead(p_key uuid) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  SELECT l.id, l.seq FROM bb.lead_requests l WHERE l.idempotency_key = p_key
$$;

CREATE FUNCTION intake_insert_lead(
  p_key uuid, p_contact uuid, p_package text, p_room text, p_date date, p_children smallint,
  p_page text, p_referrer text, p_utm_source text, p_utm_medium text, p_utm_campaign text, p_slot smallint
) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  INSERT INTO bb.lead_requests (idempotency_key, contact_id, package_id, room_id, requested_date, children, page, referrer, utm_source, utm_medium, utm_campaign, slot_id)
  VALUES (p_key, p_contact, p_package, p_room, p_date, p_children, p_page, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_slot)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING lead_requests.id, lead_requests.seq
$$;

CREATE FUNCTION intake_find_registration(p_key uuid) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  SELECT r.id, r.seq FROM bb.consent_registrations r WHERE r.idempotency_key = p_key
$$;

CREATE FUNCTION intake_insert_registration(p_key uuid, p_contact uuid) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  INSERT INTO bb.consent_registrations (idempotency_key, contact_id) VALUES (p_key, p_contact)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING consent_registrations.id, consent_registrations.seq
$$;

-- One "given" consent tied to exactly ONE of an enquiry or a registration, for a document that is published right now.
-- The API cannot record a withdrawal, a staff action, or a consent for a draft.
CREATE FUNCTION intake_add_consent(p_contact uuid, p_document uuid, p_ip_hash text, p_user_agent text, p_lead uuid, p_registration uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
BEGIN
  IF (p_lead IS NULL) = (p_registration IS NULL) THEN
    RAISE EXCEPTION 'a consent belongs to exactly one enquiry or registration' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bb.legal_documents d WHERE d.id = p_document AND d.status = 'published') THEN
    RAISE EXCEPTION 'the document is not published' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO bb.consent_events (contact_id, document_id, event, method, ip_hash, user_agent, lead_request_id, registration_id)
  VALUES (p_contact, p_document, 'given', 'web_checkbox', p_ip_hash, p_user_agent, p_lead, p_registration);
END $$;

CREATE FUNCTION intake_registration_documents(p_registration uuid) RETURNS TABLE (kind text, version integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  SELECT d.kind::text, d.version FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
   WHERE e.registration_id = p_registration ORDER BY d.kind
$$;

CREATE FUNCTION intake_queue_notification(p_lead uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.id = p_lead) THEN
    RAISE EXCEPTION 'unknown enquiry' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO bb.outbox (topic, ref_id) VALUES ('telegram.lead', p_lead) ON CONFLICT (topic, ref_id) DO NOTHING;
END $$;

-- The two audit entries the public API may write, nothing else.
CREATE FUNCTION intake_audit(p_action text, p_entity_type text, p_entity_id text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
BEGIN
  IF p_action NOT IN ('lead.created', 'consent.registered') OR p_entity_type NOT IN ('lead_request', 'consent_registration') THEN
    RAISE EXCEPTION 'not an intake audit entry' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO bb.audit_log (actor_user_id, action, entity_type, entity_id) VALUES (NULL, p_action, p_entity_type, p_entity_id);
END $$;

SELECT harden_schema();
