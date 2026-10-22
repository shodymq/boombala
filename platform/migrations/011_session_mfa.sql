-- 011_session_mfa: remember WHICH sessions passed the second factor.
-- A session created without it (before the factor was mandatory, or with MFA_MODE=off) has mfa_verified_at = NULL and is
-- refused by the admin as soon as the second factor is mandatory, even for a person who has since enrolled.
-- Existing sessions stay NULL on purpose: they are the "legacy" ones.
-- Runs with search_path = bb. Ends with harden_schema().
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;

SELECT harden_schema();
