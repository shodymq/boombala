-- 017_sheets_live_sync: shared event zones + one-way Google Sheets sync metadata.
-- Existing reservations and IDs are preserved. Sync is disabled until the owner provisions the read-only Google key,
-- reviews a dry-run and explicitly enables the systemd timer.

ALTER TABLE rooms ADD COLUMN occupancy_mode text NOT NULL DEFAULT 'exclusive'
  CHECK (occupancy_mode IN ('exclusive', 'shared'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rooms WHERE id='general-hall' AND (name <> 'Общий зал' OR occupancy_mode <> 'shared'))
     OR EXISTS (SELECT 1 FROM rooms WHERE lower(name)=lower('Общий зал') AND id <> 'general-hall') THEN
    RAISE EXCEPTION 'general-hall catalog collision; reconcile room IDs before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM rooms WHERE id='general-hall-2f' AND (name <> 'Общий зал 2 этаж' OR occupancy_mode <> 'shared'))
     OR EXISTS (SELECT 1 FROM rooms WHERE lower(name)=lower('Общий зал 2 этаж') AND id <> 'general-hall-2f') THEN
    RAISE EXCEPTION 'general-hall-2f catalog collision; reconcile room IDs before migration';
  END IF;
  INSERT INTO rooms (id, name, sort_order, is_active, occupancy_mode) VALUES
    ('general-hall', 'Общий зал', 50, true, 'shared'),
    ('general-hall-2f', 'Общий зал 2 этаж', 60, true, 'shared')
  ON CONFLICT (id) DO NOTHING;
END $$;

ALTER TABLE slot_reservations ADD COLUMN occupancy_key text;
UPDATE slot_reservations r
   SET occupancy_key = CASE WHEN room.occupancy_mode = 'shared' THEN NULL ELSE r.room_id END
  FROM rooms room
 WHERE room.id = r.room_id;

ALTER TABLE slot_reservations DROP CONSTRAINT IF EXISTS slot_reservations_active_room_interval_excl;
ALTER TABLE slot_reservations
  ADD CONSTRAINT slot_reservations_active_occupancy_interval_excl
  EXCLUDE USING gist (
    occupancy_key WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (released_at IS NULL AND occupancy_key IS NOT NULL);

CREATE OR REPLACE FUNCTION slot_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_start timestamptz;
DECLARE expected_end timestamptz;
DECLARE room_mode text;
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
        INTO NEW.starts_at, NEW.ends_at FROM time_slots t WHERE t.id = NEW.slot_id;
    END IF;
    IF NEW.starts_at IS NULL OR NEW.ends_at IS NULL OR NEW.ends_at <> NEW.starts_at + interval '4 hours' THEN
      RAISE EXCEPTION 'birthday reservations must last exactly four hours' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF extract(second FROM NEW.starts_at AT TIME ZONE 'Asia/Almaty') <> 0 THEN
      RAISE EXCEPTION 'birthday reservations must start on a whole minute' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.slot_id IS NOT NULL THEN
      SELECT (NEW.slot_date + t.starts_at) AT TIME ZONE 'Asia/Almaty',
             ((CASE WHEN t.ends_at > t.starts_at THEN NEW.slot_date ELSE NEW.slot_date + 1 END) + t.ends_at) AT TIME ZONE 'Asia/Almaty'
        INTO expected_start, expected_end FROM time_slots t WHERE t.id = NEW.slot_id;
      IF expected_start IS NULL OR NEW.starts_at <> expected_start OR NEW.ends_at <> expected_end THEN
        RAISE EXCEPTION 'reservation interval does not match its catalog slot' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    SELECT occupancy_mode INTO room_mode FROM rooms WHERE id = NEW.room_id AND is_active;
    IF room_mode IS NULL THEN
      RAISE EXCEPTION 'room is not active' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.occupancy_key := CASE WHEN room_mode = 'shared' THEN NULL ELSE NEW.room_id END;
    IF NEW.starts_at <= now() THEN
      RAISE EXCEPTION 'slot_started: this slot has already started' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reservation cannot be created already released' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.slot_date, NEW.slot_id, NEW.room_id, NEW.occupancy_key, NEW.starts_at, NEW.ends_at,
      NEW.lead_request_id, NEW.contact_id, NEW.package_id, NEW.children, NEW.price_kzt, NEW.price_source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.slot_date, OLD.slot_id, OLD.room_id, OLD.occupancy_key, OLD.starts_at, OLD.ends_at,
      OLD.lead_request_id, OLD.contact_id, OLD.package_id, OLD.children, OLD.price_kzt, OLD.price_source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a reservation (including its interval and occupancy) cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released reservation is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION rooms_occupancy_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.occupancy_mode IS DISTINCT FROM OLD.occupancy_mode AND EXISTS (
    SELECT 1 FROM slot_reservations WHERE room_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'occupancy mode cannot change after reservations exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_occupancy_mode_guard_trg
  BEFORE UPDATE OF occupancy_mode ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_occupancy_mode_guard();

-- Inactive account exists only as an audit actor for the narrowly scoped sync worker; it cannot log in.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email='sheets-sync@system.invalid'
      AND (name <> 'Google Sheets sync' OR password_hash <> '!disabled-service-account!' OR role <> 'manager' OR is_active)) THEN
    RAISE EXCEPTION 'reserved Sheets sync actor email is already assigned';
  END IF;
  INSERT INTO users (email, name, password_hash, role, is_active)
  VALUES ('sheets-sync@system.invalid', 'Google Sheets sync', '!disabled-service-account!', 'manager', false)
  ON CONFLICT (email) DO NOTHING;
END $$;

CREATE TABLE sheet_sync_runs (
  id bigserial PRIMARY KEY,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('timer', 'manual', 'dry_run')),
  outcome text NOT NULL CHECK (outcome IN ('running', 'completed', 'failed', 'skipped')),
  identity_key_fingerprint text CHECK (identity_key_fingerprint IS NULL OR identity_key_fingerprint ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_items) = 'array'),
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,60}$')
);
CREATE INDEX sheet_sync_runs_recent_idx ON sheet_sync_runs (started_at DESC);

CREATE TABLE sheet_sync_records (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  legacy_key_prefix text CHECK (legacy_key_prefix IS NULL OR legacy_key_prefix ~ '^[0-9a-f]{20}$'),
  reservation_id uuid UNIQUE REFERENCES slot_reservations(id),
  state text NOT NULL CHECK (state IN ('active', 'manual_review', 'source_missing')),
  safe_review_code text CHECK (safe_review_code IS NULL OR safe_review_code ~ '^[a-z0-9_]{1,60}$'),
  source_row_number integer CHECK (source_row_number IS NULL OR source_row_number >= 3),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sheet_sync_records_review_idx ON sheet_sync_records (state, updated_at DESC);
CREATE INDEX sheet_sync_records_reservation_idx ON sheet_sync_records (reservation_id) WHERE reservation_id IS NOT NULL;

SELECT harden_schema();
