-- 015_parent_sessions: server-side sessions of the parent cabinet on the public site (BFF).
--
-- The browser holds only an opaque session id (cookie). This table is keyed by SHA-256 of that id, so a read of the
-- table does not give a usable cookie. The FastAPI access/refresh tokens and the CSRF token are stored ENCRYPTED
-- (AES-256-GCM, key only in the environment of the process that serves the internal session API, never in the database).
-- Revocation is a timestamp; an expired or revoked row is never returned.
--
-- Access is granted only to the dedicated session role (see scripts/db-roles.ts). The public API role and the staff role
-- get nothing by default (the staff role has full data access like every table, but the secrets above are encrypted).

CREATE TABLE bb.parent_sessions (
  session_hash     bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  mobile_user_id   text        NOT NULL CHECK (length(mobile_user_id) BETWEEN 1 AND 64),
  csrf_enc         text        NOT NULL CHECK (length(csrf_enc) BETWEEN 1 AND 2000),
  access_enc       text        NOT NULL CHECK (length(access_enc) BETWEEN 1 AND 4000),
  refresh_enc      text        NOT NULL CHECK (length(refresh_enc) BETWEEN 1 AND 4000),
  access_expires_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX parent_sessions_user_idx ON bb.parent_sessions (mobile_user_id);
CREATE INDEX parent_sessions_expires_idx ON bb.parent_sessions (expires_at);

SELECT bb.harden_schema();
