-- 014_passkeys: WebAuthn passkeys (Face ID / Touch ID / security keys) as a second sign-in method for staff.
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

SELECT harden_schema();
