-- 014_passkeys: WebAuthn passkeys (Face ID / Touch ID / security keys) as a second sign-in method for staff, plus the two guards
-- that make a first factor safe to hand out: a one-time ENROLMENT CODE from the Owner and short-lived STEP-UP grants.
-- Runs with search_path = bb. Ends with harden_schema().
--
--  * Only the PUBLIC key, the credential id and a signature counter are stored: a database dump cannot sign in as anyone.
--  * A key is never deleted: it is revoked (revoked_at, revoked_by) so the history stays; a revoked key can never sign in again.
--  * Challenges are one-time, short-lived and live in the database (several application processes, restarts): the server
--    issues one with the options and consumes it exactly once when the browser answers.
--  * The password + second factor (TOTP) sign-in is untouched and stays as the fallback.

CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 16 AND 1400),
  public_key    bytea NOT NULL CHECK (length(public_key) BETWEEN 16 AND 1024),
  counter       bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     boolean NOT NULL DEFAULT false,
  label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id)
);
CREATE INDEX passkeys_user_active_idx ON passkeys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE passkey_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge  text NOT NULL UNIQUE CHECK (length(challenge) BETWEEN 16 AND 200),
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login')),
  -- register: the signed-in user who asked; login: the pending user (second-factor page) or NULL (sign-in with a discoverable passkey)
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  ip         text CHECK (ip IS NULL OR length(ip) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX passkey_challenges_expires_idx ON passkey_challenges (expires_at);

-- ── Enrolment codes: nobody enrols a first factor (TOTP or passkey) with a password alone ─────────────────────────────
-- The Owner (or the server console) issues a one-time code and hands it over in person. Only its hash is stored. A wrong code counts;
-- five wrong codes burn it. Redeeming it marks THAT pending session as allowed to enrol.
CREATE TABLE enrollment_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL CHECK (length(code_hash) = 32),
  created_by uuid REFERENCES users(id),               -- NULL: issued from the server console
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  attempts   smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX enrollment_codes_user_open_idx ON enrollment_codes (user_id) WHERE used_at IS NULL;
ALTER TABLE sessions ADD COLUMN enroll_authorized_at timestamptz;

-- ── Step-up: a sensitive action needs a FRESH proof of identity, bound to the person, the session and the action ───────
-- A stolen cookie is not enough: the proof is a current TOTP / recovery code or a passkey assertion made after the session began.
-- A grant is consumed by the action it was given for (it works once) and lapses after a few minutes.
CREATE TABLE step_up_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('passkey_register', 'passkey_revoke', 'passkeys_revoke_all', 'enrollment_code', 'mfa_reset')),
  method     text NOT NULL CHECK (method IN ('totp', 'recovery', 'passkey')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX step_up_grants_lookup_idx ON step_up_grants (session_id, purpose);

SELECT harden_schema();
