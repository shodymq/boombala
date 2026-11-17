-- 016_booking_operations: append-only idempotency and manual-payment facts for the legacy HTTPS bridge.
-- This is additive. It does not rewrite lead, consent, or historical reservation rows.

-- The legacy schema originally allowed only catalog price origins. The bridge
-- records the manager's explicitly agreed amount separately from the catalog
-- amount, so extend the enum-like check without touching existing rows.
ALTER TABLE slot_reservations DROP CONSTRAINT IF EXISTS slot_reservations_price_source_check;
ALTER TABLE slot_reservations ADD CONSTRAINT slot_reservations_price_source_check
  CHECK (price_source IS NULL OR price_source IN ('date', 'weekday', 'base', 'manager_agreed'));

CREATE TABLE booking_operations (
  idempotency_key  text PRIMARY KEY CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  operation_name  text NOT NULL CHECK (length(btrim(operation_name)) BETWEEN 1 AND 30),
  request_hash     text NOT NULL CHECK (length(request_hash) = 64),
  result           jsonb NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_operations_created_idx ON booking_operations (created_at DESC);
CREATE TRIGGER booking_operations_append_only BEFORE UPDATE OR DELETE ON booking_operations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE manual_payment_facts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_request_id  uuid NOT NULL REFERENCES lead_requests(id),
  amount_kzt       integer NOT NULL CHECK (amount_kzt > 0 AND amount_kzt <= 10000000),
  payment_method   text NOT NULL CHECK (length(btrim(payment_method)) BETWEEN 1 AND 30),
  idempotency_key  text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  note             text CHECK (note IS NULL OR length(note) <= 300),
  recorded_by      uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manual_payment_one_per_lead_idx ON manual_payment_facts (lead_request_id);
CREATE INDEX manual_payment_created_idx ON manual_payment_facts (created_at DESC);
CREATE TRIGGER manual_payment_facts_append_only BEFORE UPDATE OR DELETE ON manual_payment_facts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

SELECT harden_schema();
