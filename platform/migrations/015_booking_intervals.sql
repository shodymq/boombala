-- 015_booking_intervals: replace the three-cell occupancy guarantee with real four-hour intervals.
--
-- This migration is additive and preserves every existing reservation id and history row. The current Platform catalog
-- is a single Almaty branch, so room_id remains the occupancy partition; a branch dimension must not be invented until
-- an explicit Platform -> FastAPI branch map is approved. FastAPI remains the only writer when the unified CRM flag is on.
-- Runs with search_path = bb. Production must be backed up and overlap-checked before applying this migration.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Keep the three historical ids, but allow the additional whole-hour starts used by the current 10:00-22:00 branch.
ALTER TABLE time_slots DROP CONSTRAINT IF EXISTS time_slots_id_check;
ALTER TABLE time_slots ADD CONSTRAINT time_slots_id_positive CHECK (id > 0);
ALTER TABLE time_slots ADD CONSTRAINT time_slots_four_hour_whole_start
  CHECK (ends_at = starts_at + interval '4 hours' AND extract(minute FROM starts_at) = 0 AND extract(second FROM starts_at) = 0);
CREATE UNIQUE INDEX time_slots_start_idx ON time_slots (starts_at);

INSERT INTO time_slots (id, starts_at, ends_at) VALUES
  (4, '11:00', '15:00'),
  (5, '12:00', '16:00'),
  (6, '13:00', '17:00'),
  (7, '15:00', '19:00'),
  (8, '16:00', '20:00'),
  (9, '17:00', '21:00')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE bad_slot smallint;
BEGIN
  SELECT id INTO bad_slot
    FROM time_slots
   WHERE ends_at <> starts_at + interval '4 hours'
      OR extract(minute FROM starts_at) <> 0
      OR extract(second FROM starts_at) <> 0
   LIMIT 1;
  IF bad_slot IS NOT NULL THEN
    RAISE EXCEPTION 'time slot % is not a whole-hour four-hour interval', bad_slot;
  END IF;
END $$;

ALTER TABLE slot_reservations ADD COLUMN starts_at timestamptz;
ALTER TABLE slot_reservations ADD COLUMN ends_at timestamptz;

UPDATE slot_reservations AS r
   SET starts_at = (r.slot_date + s.starts_at) AT TIME ZONE 'Asia/Almaty',
       ends_at = (
         CASE WHEN s.ends_at > s.starts_at THEN r.slot_date ELSE r.slot_date + 1 END + s.ends_at
       ) AT TIME ZONE 'Asia/Almaty'
  FROM time_slots AS s
 WHERE s.id = r.slot_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM slot_reservations WHERE starts_at IS NULL OR ends_at IS NULL) THEN
    RAISE EXCEPTION 'cannot backfill booking intervals for every reservation';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM slot_reservations a
      JOIN slot_reservations b ON a.room_id = b.room_id AND a.id < b.id
     WHERE a.released_at IS NULL AND b.released_at IS NULL
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'active booking intervals overlap; reconcile before migration';
  END IF;
END $$;

ALTER TABLE slot_reservations ALTER COLUMN starts_at SET NOT NULL;
ALTER TABLE slot_reservations ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE slot_reservations ALTER COLUMN slot_id DROP NOT NULL;

DROP INDEX slot_reservations_active_cell_idx;
ALTER TABLE slot_reservations
  ADD CONSTRAINT slot_reservations_interval_order CHECK (ends_at > starts_at),
  ADD CONSTRAINT slot_reservations_four_hours CHECK (ends_at = starts_at + interval '4 hours');

ALTER TABLE slot_reservations
  ADD CONSTRAINT slot_reservations_active_room_interval_excl
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (released_at IS NULL);

CREATE INDEX slot_reservations_interval_date_idx ON slot_reservations (slot_date, starts_at);

-- Existing callers may still send a historical slot id. The trigger derives the interval for those rows; a future
-- interval writer may send slot_id = NULL with explicit starts_at/ends_at. In both cases the database is authoritative.
CREATE OR REPLACE FUNCTION slot_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_start timestamptz;
DECLARE expected_end timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'slot_reservations rows cannot be deleted, release them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.starts_at IS NULL OR NEW.ends_at IS NULL THEN
      IF NEW.slot_id IS NULL THEN
        RAISE EXCEPTION 'a reservation needs an explicit interval or a catalog slot' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT (NEW.slot_date + t.starts_at) AT TIME ZONE 'Asia/Almaty',
             ((CASE WHEN t.ends_at > t.starts_at THEN NEW.slot_date ELSE NEW.slot_date + 1 END) + t.ends_at) AT TIME ZONE 'Asia/Almaty'
        INTO NEW.starts_at, NEW.ends_at
        FROM time_slots t WHERE t.id = NEW.slot_id;
    END IF;
    IF NEW.starts_at IS NULL OR NEW.ends_at IS NULL OR NEW.ends_at <> NEW.starts_at + interval '4 hours' THEN
      RAISE EXCEPTION 'birthday reservations must last exactly four hours' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF extract(minute FROM NEW.starts_at AT TIME ZONE 'Asia/Almaty') <> 0
       OR extract(second FROM NEW.starts_at AT TIME ZONE 'Asia/Almaty') <> 0 THEN
      RAISE EXCEPTION 'birthday reservations must start on a whole hour' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.slot_id IS NOT NULL THEN
      SELECT (NEW.slot_date + t.starts_at) AT TIME ZONE 'Asia/Almaty',
             ((CASE WHEN t.ends_at > t.starts_at THEN NEW.slot_date ELSE NEW.slot_date + 1 END) + t.ends_at) AT TIME ZONE 'Asia/Almaty'
        INTO expected_start, expected_end
        FROM time_slots t WHERE t.id = NEW.slot_id;
      IF expected_start IS NULL OR NEW.starts_at <> expected_start OR NEW.ends_at <> expected_end THEN
        RAISE EXCEPTION 'reservation interval does not match its catalog slot' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    IF NEW.starts_at <= now() THEN
      RAISE EXCEPTION 'slot_started: this slot has already started' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reservation cannot be created already released' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.slot_date, NEW.slot_id, NEW.room_id, NEW.starts_at, NEW.ends_at, NEW.lead_request_id, NEW.contact_id,
      NEW.package_id, NEW.children, NEW.price_kzt, NEW.price_source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.slot_date, OLD.slot_id, OLD.room_id, OLD.starts_at, OLD.ends_at, OLD.lead_request_id, OLD.contact_id,
      OLD.package_id, OLD.children, OLD.price_kzt, OLD.price_source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a reservation (including its interval and price snapshot) cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released reservation is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

SELECT harden_schema();
