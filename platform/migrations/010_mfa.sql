-- 010_mfa: second factor (TOTP) for staff, one-time recovery codes, and a "password done, second factor pending" session state.
-- Runs with search_path = bb. Ends with harden_schema().
--
--  * The TOTP secret is stored ENCRYPTED (AES-256-GCM, key outside the database): a dump alone yields no codes.
--  * A code works once: `last_step` is the newest accepted time step (replay protection).
--  * Recovery codes are stored only as SHA-256 hashes and are consumed on use.
--  * A session is created at the password step as 'pending' and is useless for the admin until the second factor
--    is verified; the verified session is a NEW session (the token changes).

CREATE TABLE user_mfa (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc  text NOT NULL CHECK (length(secret_enc) BETWEEN 20 AND 400),
  enrolled_at timestamptz,
  last_step   bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL CHECK (length(code_hash) = 32),
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

ALTER TABLE sessions ADD COLUMN mfa_state text NOT NULL DEFAULT 'verified' CHECK (mfa_state IN ('pending', 'verified'));

SELECT harden_schema();
