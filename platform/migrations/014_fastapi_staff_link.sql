-- 014_fastapi_staff_link: the explicit, checked link from a Platform staff account to its FastAPI AdminUser.
-- The bridge never guesses the FastAPI identity from the e-mail alone: a staff member without this link cannot reach the
-- calendar. The value is the FastAPI AdminUser.id, set only by the server-side link script.
-- Runs with search_path = bb.

ALTER TABLE users ADD COLUMN fastapi_admin_user_id text UNIQUE
  CHECK (fastapi_admin_user_id IS NULL OR length(fastapi_admin_user_id) BETWEEN 1 AND 64);
