-- 006_bookings: slot reservations (confirmed bookings and manual blocks). An enquiry (lead_requests) never occupies
-- a slot; only a row here does, and PostgreSQL guarantees one active row per (date, slot, room).
-- Runs with search_path = bb. Ends with harden_schema().

-- The customer may name a preferred time slot in the enquiry (a preference, not a reservation).
ALTER TABLE lead_requests ADD COLUMN slot_id smallint REFERENCES time_slots(id);

CREATE TABLE slot_reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('booking', 'block')),
  slot_date        date NOT NULL,
  slot_id          smallint NOT NULL REFERENCES time_slots(id),
  room_id          text NOT NULL REFERENCES rooms(id),
  -- booking-only data. The price is a SNAPSHOT taken at confirmation: later price changes never touch it.
  lead_request_id  uuid REFERENCES lead_requests(id),
  contact_id       uuid REFERENCES contacts(id),
  package_id       text REFERENCES packages(id),
  children         smallint CHECK (children IS NULL OR children BETWEEN 0 AND 200),
  price_kzt        integer CHECK (price_kzt IS NULL OR price_kzt BETWEEN 1 AND 100000000),
  price_source     text CHECK (price_source IS NULL OR price_source IN ('date', 'weekday', 'base')),
  note             text CHECK (note IS NULL OR length(note) <= 300),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  released_by      uuid REFERENCES users(id),
  release_reason   text CHECK (release_reason IS NULL OR length(release_reason) <= 300),
  CHECK (kind = 'block' OR (contact_id IS NOT NULL AND package_id IS NOT NULL AND price_kzt IS NOT NULL AND price_source IS NOT NULL)),
  CHECK (kind = 'booking' OR (contact_id IS NULL AND package_id IS NULL AND price_kzt IS NULL AND lead_request_id IS NULL)),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

-- THE guarantee: one active reservation per date + slot + room. Both a confirmed booking and a manual block take the cell,
-- so any two writers (two managers, a booking and a block, a retry) collide here, inside PostgreSQL.
CREATE UNIQUE INDEX slot_reservations_active_cell_idx ON slot_reservations (slot_date, slot_id, room_id) WHERE released_at IS NULL;
-- One enquiry can have at most one active booking.
CREATE UNIQUE INDEX slot_reservations_active_lead_idx ON slot_reservations (lead_request_id) WHERE released_at IS NULL AND lead_request_id IS NOT NULL;
CREATE INDEX slot_reservations_date_idx ON slot_reservations (slot_date, slot_id);
CREATE INDEX slot_reservations_contact_idx ON slot_reservations (contact_id) WHERE contact_id IS NOT NULL;

-- Rows are history: no deletes; only the release columns (and the note) may change, once; the price snapshot is frozen.
-- A slot that has already started (Asia/Almaty) cannot be taken.
CREATE FUNCTION slot_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE starts timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'slot_reservations rows cannot be deleted, release them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT ((NEW.slot_date + t.starts_at) AT TIME ZONE 'Asia/Almaty') INTO starts FROM time_slots t WHERE t.id = NEW.slot_id;
    IF starts <= now() THEN
      RAISE EXCEPTION 'slot_started: this slot has already started' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reservation cannot be created already released' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.slot_date, NEW.slot_id, NEW.room_id, NEW.lead_request_id, NEW.contact_id, NEW.package_id, NEW.children, NEW.price_kzt, NEW.price_source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.slot_date, OLD.slot_id, OLD.room_id, OLD.lead_request_id, OLD.contact_id, OLD.package_id, OLD.children, OLD.price_kzt, OLD.price_source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a reservation (including its price snapshot) cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released reservation is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_reservations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON slot_reservations
  FOR EACH ROW EXECUTE FUNCTION slot_reservations_guard();
CREATE TRIGGER slot_reservations_no_truncate BEFORE TRUNCATE ON slot_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

SELECT harden_schema();
