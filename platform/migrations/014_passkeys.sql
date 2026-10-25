-- 014_passkeys: WebAuthn/passkey credentials and one-time server challenges.
-- Credentials are public keys; no private key or biometric material is stored.
-- Challenges are short-lived and consumed exactly once by the application.

CREATE TABLE passkeys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id     text NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 20 AND 1024),
  public_key        bytea NOT NULL CHECK (length(public_key) BETWEEN 16 AND 4096),
  counter           bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports        text[] NOT NULL DEFAULT '{}',
  device_type       text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up         boolean NOT NULL DEFAULT false,
  label             text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_user_active_idx ON passkeys (user_id, created_at) WHERE revoked_at IS NULL;

CREATE TABLE passkey_challenges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose           text NOT NULL CHECK (purpose IN ('login', 'registration')),
  challenge         text NOT NULL UNIQUE CHECK (length(challenge) BETWEEN 20 AND 512),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkey_challenges_lookup_idx ON passkey_challenges (user_id, purpose, expires_at) WHERE consumed_at IS NULL;

SELECT harden_schema();
