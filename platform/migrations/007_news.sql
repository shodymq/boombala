-- 007_news: news and promotions (drafts, publication, removal from public access) and their images.
-- Images are stored re-encoded in the database (no metadata, no third-party storage account); see docs/platform/NEWS.md.
-- Runs with search_path = bb. Ends with harden_schema().

CREATE TABLE news_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime       text NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg', 'image/png')),
  data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 100 AND 3000000),
  width      integer NOT NULL CHECK (width BETWEEN 16 AND 4000),
  height     integer NOT NULL CHECK (height BETWEEN 16 AND 4000),
  sha256     bytea NOT NULL CHECK (length(sha256) = 32),
  alt        text NOT NULL CHECK (length(btrim(alt)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The same picture is stored once.
CREATE UNIQUE INDEX news_images_sha_idx ON news_images (sha256);
-- The pixels never change (a new picture is a new row), so public URLs can be cached forever.
CREATE TRIGGER news_images_immutable BEFORE UPDATE ON news_images FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE news_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  kind            text NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'promo')),
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  excerpt         text NOT NULL DEFAULT '' CHECK (length(excerpt) <= 300),
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 30000),
  cover_image_id  uuid REFERENCES news_images(id),
  seo_title       text CHECK (seo_title IS NULL OR length(seo_title) <= 70),
  seo_description text CHECK (seo_description IS NULL OR length(seo_description) <= 200),
  -- promotions only: last day the offer is valid (Asia/Almaty calendar date)
  valid_until     date,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  -- shown date and the moment it becomes public (may be in the future = scheduled)
  published_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK (kind = 'promo' OR valid_until IS NULL)
);
CREATE INDEX news_posts_public_idx ON news_posts (published_at DESC) WHERE status = 'published';
CREATE INDEX news_posts_status_idx ON news_posts (status, updated_at DESC);

-- A URL that has been public must not change (search engines, shared links): the slug is frozen after the first publication.
-- Published posts cannot be deleted: take them down (archive) first.
CREATE FUNCTION news_posts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'a published post cannot be deleted: unpublish it first' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.slug <> OLD.slug AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'the address of a post that has been published cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER news_posts_guard_trg BEFORE UPDATE OR DELETE ON news_posts FOR EACH ROW EXECUTE FUNCTION news_posts_guard();

SELECT harden_schema();
