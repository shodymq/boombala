-- 001_core: staff accounts, sessions, login throttling, audit log.
-- Every table is created for PostgreSQL 16. Email is stored lower-case (checked), so no extension is needed.

CREATE TYPE user_role AS ENUM ('owner', 'manager', 'editor');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1 AND length(email) <= 254),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Only the SHA-256 of the cookie token is stored: a database leak does not yield usable sessions.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  ip           text,
  user_agent   text CHECK (user_agent IS NULL OR length(user_agent) <= 400)
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Login throttling lives in PostgreSQL (no Redis): works across app restarts and several instances.
CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email_norm text NOT NULL,
  ip         text NOT NULL,
  success    boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email_norm, at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at DESC);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type   text,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  ip            text,
  user_agent    text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- Shared guard: history tables are append-only.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
