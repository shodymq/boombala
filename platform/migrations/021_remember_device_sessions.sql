-- 021_remember_device_sessions: explicit bounded long-lived session policy for personal devices.
-- Existing rows remain on the short policy and are not extended. Pending MFA sessions still expire after ten minutes.

ALTER TABLE bb.sessions
  ADD COLUMN remember_device boolean NOT NULL DEFAULT false;

SELECT harden_schema();
