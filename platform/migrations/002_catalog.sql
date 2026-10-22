-- 002_catalog: packages, rooms, the three fixed time slots and the append-only price history.

CREATE TABLE packages (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]+$'),
  name       text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);

-- Rooms are never deleted (bookings will reference them); they can only be deactivated.
CREATE TABLE rooms (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]+$'),
  name       text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);
CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted, deactivate instead', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER rooms_no_delete BEFORE DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER packages_no_delete BEFORE DELETE ON packages FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Exactly three fixed slots, no free-form intervals. All packages take one four-hour slot.
CREATE TABLE time_slots (
  id        smallint PRIMARY KEY CHECK (id BETWEEN 1 AND 3),
  starts_at time NOT NULL,
  ends_at   time NOT NULL,
  CHECK (ends_at > starts_at)
);
INSERT INTO time_slots (id, starts_at, ends_at) VALUES
  (1, '10:00', '14:00'),
  (2, '14:00', '18:00'),
  (3, '18:00', '22:00');
CREATE TRIGGER time_slots_no_delete BEFORE DELETE ON time_slots FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Price history is append-only. The current value per (package, rule_type, rule_date) is its latest row.
--   base    : the regular price
--   weekday : price on Monday-Friday (Asia/Almaty calendar date)
--   date    : special price for one date; amount_kzt NULL = "special price removed"
CREATE TABLE price_rules (
  id         bigserial PRIMARY KEY,
  package_id text NOT NULL REFERENCES packages(id),
  rule_type  text NOT NULL CHECK (rule_type IN ('base', 'weekday', 'date')),
  rule_date  date,
  amount_kzt integer CHECK (amount_kzt IS NULL OR amount_kzt BETWEEN 1 AND 100000000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  note       text CHECK (note IS NULL OR length(note) <= 300),
  CHECK ((rule_type = 'date') = (rule_date IS NOT NULL)),
  CHECK (amount_kzt IS NOT NULL OR rule_type = 'date')
);
CREATE INDEX price_rules_lookup_idx ON price_rules (package_id, rule_type, rule_date, id DESC);
CREATE TRIGGER price_rules_append_only BEFORE UPDATE OR DELETE ON price_rules
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER price_rules_no_truncate BEFORE TRUNCATE ON price_rules
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
