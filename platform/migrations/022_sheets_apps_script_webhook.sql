-- 022_sheets_apps_script_webhook: authenticated Apps Script push snapshots.
-- Additive only. No route or timer is enabled by this migration.

ALTER TABLE sheet_sync_runs DROP CONSTRAINT IF EXISTS sheet_sync_runs_trigger_kind_check;
ALTER TABLE sheet_sync_runs ADD CONSTRAINT sheet_sync_runs_trigger_kind_check
  CHECK (trigger_kind IN ('timer', 'manual', 'dry_run', 'webhook'));

CREATE TABLE sheet_sync_webhook_requests (
  request_id uuid PRIMARY KEY,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  lease_id uuid,
  lease_until timestamptz,
  sync_run_id bigint REFERENCES sheet_sync_runs(id),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sheet_sync_webhook_requests_recent_idx ON sheet_sync_webhook_requests (created_at DESC);

CREATE TABLE sheet_sync_webhook_nonces (
  nonce uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES sheet_sync_webhook_requests(request_id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sheet_sync_webhook_nonces_age_idx ON sheet_sync_webhook_nonces (received_at);

SELECT harden_schema();
