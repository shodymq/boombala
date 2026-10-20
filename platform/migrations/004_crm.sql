-- 004_crm: contacts, enquiries (birthday form), QR registrations, versioned legal documents, consent history,
-- outbox for Telegram notifications and the export log. Runs with search_path = bb. Ends with harden_schema().

-- Staff who may export contact data (the Owner always may).
ALTER TABLE users ADD COLUMN can_export boolean NOT NULL DEFAULT false;

-- ── Versioned legal documents ─────────────────────────────────────────────────────────────────────────────────
CREATE TYPE legal_doc_kind AS ENUM (
  'privacy_policy', 'visit_rules', 'companion_duties', 'personal_data_consent', 'third_party_escort', 'group_visits'
);
CREATE TYPE legal_doc_status AS ENUM ('draft', 'approved', 'published', 'retired');

CREATE TABLE legal_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         legal_doc_kind NOT NULL,
  version      integer NOT NULL CHECK (version >= 1),
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 100000),
  status       legal_doc_status NOT NULL DEFAULT 'draft',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  published_at timestamptz,
  retired_at   timestamptz,
  UNIQUE (kind, version)
);
-- One published version per kind at a time.
CREATE UNIQUE INDEX legal_one_published_idx ON legal_documents (kind) WHERE status = 'published';

-- Text that still contains a "[ТРЕБУЕТСЯ …]" placeholder can never be approved or published; approved/published
-- text can never be edited, only retired. Drafts may be edited or deleted.
CREATE FUNCTION legal_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft legal document can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.kind <> OLD.kind OR NEW.version <> OLD.version OR NEW.title <> OLD.title OR NEW.body <> OLD.body) THEN
    RAISE EXCEPTION 'an approved or published legal document cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('approved', 'published') AND position('[ТРЕБУЕТСЯ' in NEW.body) > 0 THEN
    RAISE EXCEPTION 'a legal document with unfilled [ТРЕБУЕТСЯ …] placeholders cannot be approved or published' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'approved') OR
       (OLD.status = 'approved' AND NEW.status = 'published') OR
       (OLD.status = 'published' AND NEW.status = 'retired') OR
       (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'illegal legal document status change % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_documents_guard_trg BEFORE UPDATE OR DELETE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION legal_documents_guard();

-- ── Contacts ──────────────────────────────────────────────────────────────────────────────────────────────────
-- A contact is "this phone number + this name". The same phone with a DIFFERENT name is a different contact
-- (an unverified phone is not proof of identity); the UI shows "same number on N other contacts".
CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  name_key            text NOT NULL,
  phone_e164          text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{9,14}$'),
  source              text NOT NULL CHECK (source IN ('qr', 'birthday_form', 'manual')),
  first_registered_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  phone_verification  text NOT NULL DEFAULT 'unverified' CHECK (phone_verification IN ('unverified', 'verified')),
  marketing_opt_in    boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone_e164, name_key)
);
CREATE INDEX contacts_phone_idx ON contacts (phone_e164);
CREATE INDEX contacts_activity_idx ON contacts (last_activity_at DESC);
CREATE INDEX contacts_first_idx ON contacts (first_registered_at DESC);

-- ── Events: enquiries and QR registrations are separate events of one contact ────────────────────────────────────
CREATE TABLE lead_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  package_id      text REFERENCES packages(id),
  room_id         text REFERENCES rooms(id),
  requested_date  date NOT NULL,
  children        smallint CHECK (children IS NULL OR children BETWEEN 0 AND 200),
  page            text CHECK (page IS NULL OR length(page) <= 200),
  referrer        text CHECK (referrer IS NULL OR length(referrer) <= 300),
  utm_source      text CHECK (utm_source IS NULL OR length(utm_source) <= 100),
  utm_medium      text CHECK (utm_medium IS NULL OR length(utm_medium) <= 100),
  utm_campaign    text CHECK (utm_campaign IS NULL OR length(utm_campaign) <= 100),
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'confirmed', 'cancelled', 'completed')),
  assigned_to     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_requests_contact_idx ON lead_requests (contact_id, created_at DESC);
CREATE INDEX lead_requests_status_idx ON lead_requests (status, created_at DESC);

CREATE TABLE consent_registrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  source          text NOT NULL DEFAULT 'qr' CHECK (source IN ('qr')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_registrations_contact_idx ON consent_registrations (contact_id, created_at DESC);

-- ── Consent history: append-only, every row names the exact document version ─────────────────────────────────
CREATE TABLE consent_events (
  id              bigserial PRIMARY KEY,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  document_id     uuid NOT NULL REFERENCES legal_documents(id),
  event           text NOT NULL CHECK (event IN ('given', 'revoked')),
  method          text NOT NULL CHECK (method IN ('web_checkbox', 'staff')),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  ip_hash         text CHECK (ip_hash IS NULL OR length(ip_hash) <= 64),
  user_agent      text CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  lead_request_id uuid REFERENCES lead_requests(id),
  registration_id uuid REFERENCES consent_registrations(id),
  note            text CHECK (note IS NULL OR length(note) <= 300),
  recorded_by     uuid REFERENCES users(id)
);
CREATE INDEX consent_events_contact_idx ON consent_events (contact_id, occurred_at DESC);
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── Outbox: one notification task per enquiry, saved in the SAME transaction as the enquiry ───────────────────
-- Only a reference is stored (no personal data): the message is built from the enquiry when it is sent.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           text NOT NULL CHECK (topic IN ('telegram.lead')),
  ref_id          uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 60),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (topic, ref_id)
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status IN ('pending', 'sending');

-- ── Export log: every download is recorded ────────────────────────────────────────────────────────────────────
CREATE TABLE export_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now(),
  format     text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  date_from  date,
  date_to    date,
  filters    jsonb,
  columns    text[] NOT NULL,
  row_count  integer NOT NULL CHECK (row_count >= 0),
  ip         text
);
CREATE TRIGGER export_log_append_only BEFORE UPDATE OR DELETE ON export_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

SELECT harden_schema();
