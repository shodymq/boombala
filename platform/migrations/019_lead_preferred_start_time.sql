-- 019_lead_preferred_start_time: preserve the visitor's requested HH:00 separately from legacy booking slots.
-- Additive for existing enquiries: historical rows keep their IDs and slot_id; their new preference is NULL.

ALTER TABLE lead_requests ADD COLUMN preferred_start_time time without time zone;
ALTER TABLE lead_requests ADD CONSTRAINT lead_requests_preferred_start_time_check CHECK (
  preferred_start_time IS NULL OR (
    preferred_start_time >= time '10:00' AND preferred_start_time <= time '22:00'
    AND extract(minute FROM preferred_start_time) = 0
    AND extract(second FROM preferred_start_time) = 0
  )
);

-- Add a versioned overload instead of dropping the legacy signature. This keeps the prior site/API
-- runnable during rollback while new strict releases persist the time preference separately.
CREATE FUNCTION intake_insert_lead(
  p_key uuid, p_contact uuid, p_package text, p_room text, p_date date, p_children smallint,
  p_page text, p_referrer text, p_utm_source text, p_utm_medium text, p_utm_campaign text,
  p_slot smallint, p_preferred_start_time time without time zone
) RETURNS TABLE (id uuid, seq bigint)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bb AS $$
  INSERT INTO bb.lead_requests (
    idempotency_key, contact_id, package_id, room_id, requested_date, children,
    page, referrer, utm_source, utm_medium, utm_campaign, slot_id, preferred_start_time
  )
  VALUES (
    p_key, p_contact, p_package, p_room, p_date, p_children,
    p_page, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_slot, p_preferred_start_time
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING lead_requests.id, lead_requests.seq
$$;

SELECT harden_schema();
