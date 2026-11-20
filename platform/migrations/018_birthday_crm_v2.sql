-- 018_birthday_crm_v2: Pricing V4.2 catalog (versioned), the booking card (Booking V2) and its change history.
-- Additive. Existing packages, reservations, prices and payment facts are not rewritten. The old packages are archived for new
-- sales only (is_active = false); their rows, price history and every reservation that references them stay.
-- Runs with search_path = bb. Ends with harden_schema().

-- ── Catalog: three V4.2 packages ───────────────────────────────────────────────────────────────────────────────
-- Prices live where they always lived (price_rules: base = weekend, weekday = Mon-Fri, date = holiday/special date), so the
-- owner keeps one place to change a price and nothing is duplicated here.

CREATE TABLE package_archive (
  package_id  text PRIMARY KEY REFERENCES packages(id),
  archived_at timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL
);

INSERT INTO packages (id, name, sort_order, is_active) VALUES
  ('happy-party', 'Happy Party', 0, true),
  ('star-party', 'Star Party', 1, true),
  ('boom-bala-party', 'Boom Bala Party', 2, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO price_rules (package_id, rule_type, amount_kzt, note)
SELECT v.id, v.rule_type, v.amount, 'Pricing V4.2'
  FROM (VALUES
    ('happy-party', 'base', 54900), ('happy-party', 'weekday', 38430),
    ('star-party', 'base', 79900), ('star-party', 'weekday', 55930),
    ('boom-bala-party', 'base', 114900), ('boom-bala-party', 'weekday', 80430)
  ) AS v(id, rule_type, amount)
 WHERE NOT EXISTS (SELECT 1 FROM price_rules p WHERE p.package_id = v.id);

-- Old packages stay as history. A package listed here can never be sold again, also in a database that is seeded later.
INSERT INTO package_archive (package_id, reason)
SELECT id, 'replaced by Pricing V4.2' FROM packages WHERE id IN ('wow-party', 'magic-party', 'boom-party')
ON CONFLICT DO NOTHING;
UPDATE packages SET is_active = false, sort_order = sort_order + 10 WHERE id IN (SELECT package_id FROM package_archive) AND is_active;

-- BEFORE INSERT forces is_active = false; the archive row is written AFTER the package row exists (foreign key).
CREATE FUNCTION packages_archive_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO package_archive (package_id, reason) VALUES (NEW.id, 'replaced by Pricing V4.2') ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE FUNCTION packages_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IN ('wow-party', 'magic-party', 'boom-party') THEN NEW.is_active := false; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER packages_archive_guard_trg BEFORE INSERT ON packages FOR EACH ROW EXECUTE FUNCTION packages_archive_guard();
CREATE TRIGGER packages_archive_after_trg AFTER INSERT ON packages FOR EACH ROW
  WHEN (NEW.id IN ('wow-party', 'magic-party', 'boom-party')) EXECUTE FUNCTION packages_archive_after();

-- A version of the commercial terms of a package. A booking records the version it was agreed under.
CREATE TABLE package_versions (
  package_id               text NOT NULL REFERENCES packages(id),
  version                  text NOT NULL CHECK (version ~ '^[a-z0-9.-]{1,20}$'),
  included_children        smallint NOT NULL CHECK (included_children BETWEEN 1 AND 100),
  included_adults          smallint NOT NULL CHECK (included_adults BETWEEN 0 AND 50),
  animators                smallint NOT NULL CHECK (animators BETWEEN 0 AND 10),
  program_minutes          smallint NOT NULL CHECK (program_minutes BETWEEN 1 AND 600),
  room_minutes             smallint NOT NULL CHECK (room_minutes = 240),
  extra_child_discount_pct smallint NOT NULL CHECK (extra_child_discount_pct BETWEEN 0 AND 100),
  weekday_discount_pct     smallint NOT NULL CHECK (weekday_discount_pct BETWEEN 0 AND 100),
  cake_ceremony            boolean NOT NULL DEFAULT false,
  online_invitation        boolean NOT NULL DEFAULT false,
  is_current               boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, version)
);
CREATE UNIQUE INDEX package_versions_current_idx ON package_versions (package_id) WHERE is_current;

INSERT INTO package_versions (package_id, version, included_children, included_adults, animators, program_minutes, room_minutes, extra_child_discount_pct, weekday_discount_pct, cake_ceremony, online_invitation, is_current) VALUES
  ('happy-party', 'v4.2', 6, 0, 1, 60, 240, 20, 30, false, false, true),
  ('star-party', 'v4.2', 7, 0, 2, 90, 240, 20, 30, true, false, true),
  ('boom-bala-party', 'v4.2', 10, 3, 2, 150, 240, 20, 30, true, true, true);

-- One entertainment catalog: stable ids, RU and KZ names. Nothing else in the system keeps its own list.
CREATE TABLE program_options (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]+$'),
  kind       text NOT NULL CHECK (kind IN ('show', 'master_class', 'challenge', 'animation')),
  name_ru    text NOT NULL,
  name_kk    text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0
);
INSERT INTO program_options (id, kind, name_ru, name_kk, sort_order) VALUES
  ('silver-show', 'show', 'Серебряное шоу', 'Күміс шоу', 1),
  ('neon-show', 'show', 'Неоновое шоу', 'Неон шоу', 2),
  ('mystery-box', 'show', 'Что в коробке?', 'Қорапта не бар?', 3),
  ('dino-show', 'show', 'Дино-шоу', 'Дино-шоу', 4),
  ('cotton-candy-show', 'show', 'Шоу сладкой ваты', 'Мақта кәмпит шоуы', 5),
  ('beauty-bar', 'show', 'Бьюти-бар', 'Бьюти-бар', 6),
  ('slime', 'master_class', 'Создание слаймов', 'Слайм жасау', 1),
  ('kapitoshka', 'master_class', 'Создание капитошек', 'Капитошка жасау', 2),
  ('name-bracelet', 'master_class', 'Именные браслеты', 'Есім жазылған білезіктер', 3),
  ('cap-painting', 'master_class', 'Роспись кепок', 'Кепкаға сурет салу', 4),
  ('canvas-painting', 'master_class', 'Рисование на холсте', 'Кенепке сурет салу', 5),
  ('keychain-painting', 'master_class', 'Роспись брелоков', 'Брелоктарды бояу', 6),
  ('guess-drink', 'challenge', 'Угадай напиток', 'Сусынды тап', 1),
  ('fortune-wheel', 'challenge', 'Колесо фортуны', 'Сәттілік дөңгелегі', 2),
  ('shakers', 'challenge', 'Трясуны', 'Трясуны', 3),
  ('bottle-challenge', 'challenge', 'Бутылка-челлендж', 'Бөтелке челленджі', 4),
  ('active-games', 'animation', 'Активные игры', 'Қимылды ойындар', 1),
  ('board-games', 'animation', 'Настольные игры', 'Үстел ойындары', 2),
  ('toddler-interactive', 'animation', 'Интерактив для малышей', 'Бүлдіршіндерге арналған интерактив', 3);

-- What a package includes per kind: how many to pick (pick_count 0 = a fixed block without a choice) and its minutes.
CREATE TABLE package_program_rules (
  package_id text NOT NULL,
  version    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('show', 'master_class', 'challenge', 'animation')),
  pick_count smallint NOT NULL CHECK (pick_count BETWEEN 0 AND 6),
  minutes    smallint NOT NULL CHECK (minutes BETWEEN 1 AND 300),
  PRIMARY KEY (package_id, version, kind),
  FOREIGN KEY (package_id, version) REFERENCES package_versions (package_id, version)
);
CREATE TABLE package_program_options (
  package_id text NOT NULL,
  version    text NOT NULL,
  kind       text NOT NULL,
  option_id  text NOT NULL REFERENCES program_options(id),
  PRIMARY KEY (package_id, version, option_id),
  FOREIGN KEY (package_id, version, kind) REFERENCES package_program_rules (package_id, version, kind)
);

INSERT INTO package_program_rules (package_id, version, kind, pick_count, minutes) VALUES
  ('happy-party', 'v4.2', 'animation', 1, 20), ('happy-party', 'v4.2', 'show', 1, 15),
  ('star-party', 'v4.2', 'animation', 1, 20), ('star-party', 'v4.2', 'show', 2, 30), ('star-party', 'v4.2', 'challenge', 1, 15),
  ('boom-bala-party', 'v4.2', 'show', 2, 35), ('boom-bala-party', 'v4.2', 'master_class', 1, 30),
  ('boom-bala-party', 'v4.2', 'challenge', 1, 15), ('boom-bala-party', 'v4.2', 'animation', 0, 30);

INSERT INTO package_program_options (package_id, version, kind, option_id) VALUES
  ('happy-party', 'v4.2', 'animation', 'active-games'), ('happy-party', 'v4.2', 'animation', 'board-games'), ('happy-party', 'v4.2', 'animation', 'toddler-interactive'),
  ('happy-party', 'v4.2', 'show', 'silver-show'), ('happy-party', 'v4.2', 'show', 'mystery-box'), ('happy-party', 'v4.2', 'show', 'dino-show'),
  ('star-party', 'v4.2', 'animation', 'active-games'), ('star-party', 'v4.2', 'animation', 'board-games'), ('star-party', 'v4.2', 'animation', 'toddler-interactive'),
  ('star-party', 'v4.2', 'show', 'silver-show'), ('star-party', 'v4.2', 'show', 'neon-show'), ('star-party', 'v4.2', 'show', 'dino-show'), ('star-party', 'v4.2', 'show', 'mystery-box'),
  ('star-party', 'v4.2', 'challenge', 'guess-drink'), ('star-party', 'v4.2', 'challenge', 'fortune-wheel'), ('star-party', 'v4.2', 'challenge', 'shakers'), ('star-party', 'v4.2', 'challenge', 'bottle-challenge'),
  ('boom-bala-party', 'v4.2', 'show', 'neon-show'), ('boom-bala-party', 'v4.2', 'show', 'silver-show'), ('boom-bala-party', 'v4.2', 'show', 'mystery-box'),
  ('boom-bala-party', 'v4.2', 'show', 'dino-show'), ('boom-bala-party', 'v4.2', 'show', 'cotton-candy-show'), ('boom-bala-party', 'v4.2', 'show', 'beauty-bar'),
  ('boom-bala-party', 'v4.2', 'master_class', 'slime'), ('boom-bala-party', 'v4.2', 'master_class', 'kapitoshka'), ('boom-bala-party', 'v4.2', 'master_class', 'name-bracelet'),
  ('boom-bala-party', 'v4.2', 'master_class', 'cap-painting'), ('boom-bala-party', 'v4.2', 'master_class', 'canvas-painting'), ('boom-bala-party', 'v4.2', 'master_class', 'keychain-painting'),
  ('boom-bala-party', 'v4.2', 'challenge', 'shakers'), ('boom-bala-party', 'v4.2', 'challenge', 'guess-drink'), ('boom-bala-party', 'v4.2', 'challenge', 'fortune-wheel'), ('boom-bala-party', 'v4.2', 'challenge', 'bottle-challenge');

-- Entrance tariffs of extra guests. NOT seeded: the business has not approved them. Until a row exists the calculation reports
-- an incomplete price and the manager agrees the amount by hand. kind = 'child' | 'adult'.
CREATE TABLE guest_tariffs (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('child', 'adult')),
  amount_kzt integer NOT NULL CHECK (amount_kzt BETWEEN 1 AND 10000000),
  valid_from date NOT NULL DEFAULT current_date,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  note       text CHECK (note IS NULL OR length(note) <= 300)
);
CREATE INDEX guest_tariffs_lookup_idx ON guest_tariffs (kind, valid_from DESC, id DESC);
CREATE TRIGGER guest_tariffs_append_only BEFORE UPDATE OR DELETE ON guest_tariffs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── The booking card ───────────────────────────────────────────────────────────────────────────────────────────
-- A reservation is immutable (a move releases it and writes a new row), so everything the manager edits lives here, keyed
-- by the event, and follows the current reservation. One card per active reservation.
CREATE TABLE booking_cards (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id           uuid NOT NULL UNIQUE REFERENCES slot_reservations(id),
  lead_request_id          uuid UNIQUE REFERENCES lead_requests(id),
  package_id               text REFERENCES packages(id),
  terms_version            text,
  preferred_language       text CHECK (preferred_language IS NULL OR preferred_language IN ('ru', 'kk')),
  child_name               text CHECK (child_name IS NULL OR length(child_name) BETWEEN 1 AND 80),
  child_age                smallint CHECK (child_age IS NULL OR child_age BETWEEN 0 AND 99),
  headcount_mode           text NOT NULL DEFAULT 'exact' CHECK (headcount_mode IN ('exact', 'by_fact')),
  children_total           smallint CHECK (children_total IS NULL OR children_total BETWEEN 0 AND 200),
  adults_total             smallint CHECK (adults_total IS NULL OR adults_total BETWEEN 0 AND 200),
  animators                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(animators) = 'array' AND jsonb_array_length(animators) <= 10),
  -- The chosen entertainment: [{kind, optionId}]. Validated against the package's offered options on every write (no DELETE
  -- privilege is needed for the staff role: the whole selection is replaced in one UPDATE, the history keeps the changes).
  selections               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selections) = 'array' AND jsonb_array_length(selections) <= 20),
  responsible_user_id      uuid REFERENCES users(id),
  animation_note           text CHECK (animation_note IS NULL OR length(animation_note) <= 300),
  wishes                   text CHECK (wishes IS NULL OR length(wishes) <= 1000),
  decoration               text CHECK (decoration IS NULL OR length(decoration) <= 300),
  cake                     text CHECK (cake IS NULL OR length(cake) <= 300),
  staff_comment            text CHECK (staff_comment IS NULL OR length(staff_comment) <= 1000),
  program_status           text NOT NULL DEFAULT 'draft' CHECK (program_status IN ('draft', 'approved')),
  props_status             text NOT NULL DEFAULT 'not_started' CHECK (props_status IN ('not_started', 'preparing', 'ready')),
  invitation_status        text NOT NULL DEFAULT 'not_applicable' CHECK (invitation_status IN ('not_applicable', 'not_started', 'in_progress', 'sent')),
  -- Money. The base price is the amount frozen on the reservation when it was agreed; it is never recalculated from the catalog.
  base_price_kzt           integer CHECK (base_price_kzt IS NULL OR base_price_kzt >= 0),
  extra_children_kzt       integer CHECK (extra_children_kzt IS NULL OR extra_children_kzt >= 0),
  extra_adults_kzt         integer CHECK (extra_adults_kzt IS NULL OR extra_adults_kzt >= 0),
  manual_extra_children_kzt integer CHECK (manual_extra_children_kzt IS NULL OR manual_extra_children_kzt BETWEEN 0 AND 10000000),
  manual_extra_adults_kzt  integer CHECK (manual_extra_adults_kzt IS NULL OR manual_extra_adults_kzt BETWEEN 0 AND 10000000),
  services                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(services) = 'array' AND jsonb_array_length(services) <= 30),
  services_kzt             integer NOT NULL DEFAULT 0 CHECK (services_kzt >= 0),
  meal_kzt                 integer NOT NULL DEFAULT 0 CHECK (meal_kzt BETWEEN 0 AND 10000000),
  pricing_status           text NOT NULL DEFAULT 'complete' CHECK (pricing_status IN ('complete', 'incomplete')),
  pricing_gaps             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pricing_gaps) = 'array'),
  total_kzt                integer CHECK (total_kzt IS NULL OR total_kzt >= 0),
  version                  integer NOT NULL DEFAULT 1,
  created_by               uuid NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid NOT NULL REFERENCES users(id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, terms_version) REFERENCES package_versions (package_id, version),
  -- A card of an archived package (no V4.2 terms) keeps the historic package link with terms_version NULL.
  CHECK (terms_version IS NULL OR package_id IS NOT NULL)
);
CREATE INDEX booking_cards_responsible_idx ON booking_cards (responsible_user_id) WHERE responsible_user_id IS NOT NULL;

-- The history of one event. Append-only. `changes` holds {field: {from, to}} for edits and a few facts for other actions.
CREATE TABLE booking_card_events (
  id             bigserial PRIMARY KEY,
  card_id        uuid NOT NULL REFERENCES booking_cards(id),
  reservation_id uuid REFERENCES slot_reservations(id),
  actor_user_id  uuid NOT NULL REFERENCES users(id),
  action         text NOT NULL CHECK (action IN ('created', 'updated', 'program_approved', 'program_reopened', 'rescheduled', 'prepayment_recorded', 'cancelled', 'handed_over')),
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_card_events_card_idx ON booking_card_events (card_id, id DESC);
CREATE TRIGGER booking_card_events_append_only BEFORE UPDATE OR DELETE ON booking_card_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── Sheets handover ────────────────────────────────────────────────────────────────────────────────────────────
-- A record the sync created can be handed over to the CRM. The sync worker never touches 'crm_managed' records again.
ALTER TABLE sheet_sync_records DROP CONSTRAINT IF EXISTS sheet_sync_records_state_check;
ALTER TABLE sheet_sync_records ADD CONSTRAINT sheet_sync_records_state_check CHECK (state IN ('active', 'manual_review', 'source_missing', 'crm_managed'));

SELECT harden_schema();
