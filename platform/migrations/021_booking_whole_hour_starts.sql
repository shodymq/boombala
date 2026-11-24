-- 021_booking_whole_hour_starts: enforce HH:00 for new intervals without rewriting historical reservations.
-- Migration is additive. The INSERT-only trigger lets existing rows remain byte-for-byte unchanged; the existing 4-hour
-- CHECK and exclusive-room interval constraint continue to enforce duration and overlap (adjacent bookings are allowed).

CREATE OR REPLACE FUNCTION slot_reservations_whole_hour_start() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE local_start timestamp;
BEGIN
  local_start := NEW.starts_at AT TIME ZONE 'Asia/Almaty';
  IF extract(minute FROM local_start) <> 0 OR extract(second FROM local_start) <> 0 THEN
    RAISE EXCEPTION 'birthday reservations must start on a whole hour' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- The existing slot_reservations_guard trigger runs first alphabetically and derives starts_at for legacy slot IDs.
CREATE TRIGGER slot_reservations_whole_hour_start
  BEFORE INSERT ON slot_reservations
  FOR EACH ROW EXECUTE FUNCTION slot_reservations_whole_hour_start();

SELECT harden_schema();
