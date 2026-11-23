-- 022_lead_manager_agreement: keep the manager's agreed customer follow-up on the existing lead.
-- Additive and nullable; existing lead rows and workflow history remain unchanged.

ALTER TABLE bb.lead_requests
  ADD COLUMN manager_agreement text
  CONSTRAINT lead_requests_manager_agreement_check
  CHECK (manager_agreement IS NULL OR length(manager_agreement) <= 1000);

SELECT harden_schema();
