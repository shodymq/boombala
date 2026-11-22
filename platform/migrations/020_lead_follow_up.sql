-- 020_lead_follow_up: additive manager workflow on the existing lead entity.
-- Existing IDs, statuses, assignments, and audit rows are preserved.

ALTER TABLE bb.lead_requests
  ADD COLUMN next_action text,
  ADD COLUMN follow_up_at timestamptz,
  ADD COLUMN workflow_version integer NOT NULL DEFAULT 1;

ALTER TABLE bb.lead_requests
  ADD CONSTRAINT lead_requests_next_action_check CHECK (
    next_action IS NULL OR next_action IN (
      'call_customer',
      'clarify_details',
      'prepare_offer',
      'await_reply',
      'schedule_visit'
    )
  ),
  ADD CONSTRAINT lead_requests_follow_up_pair_check CHECK (
    (next_action IS NULL) = (follow_up_at IS NULL)
  ),
  ADD CONSTRAINT lead_requests_workflow_version_check CHECK (workflow_version >= 1);

CREATE INDEX lead_requests_follow_up_idx
  ON bb.lead_requests (follow_up_at, requested_date, id)
  WHERE status IN ('new', 'in_progress') AND follow_up_at IS NOT NULL;
