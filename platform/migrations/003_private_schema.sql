-- 003_private_schema: closed schema + deny-by-default row security.
-- Plain PostgreSQL compatible. On Supabase it keeps every table out of the Data API:
--   * the schema `bb` is not an "exposed schema"
--   * RLS is ON for every table and there are NO policies, so any role other than the owner sees nothing
--   * privileges are revoked from PUBLIC and, when they exist, anon / authenticated / service_role
-- The application connects as the owner role over a normal PostgreSQL connection (never with a Supabase API key).

-- Databases created before the runner started using `bb` still have objects in `public`: move them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'login_attempts', 'audit_log', 'packages', 'rooms', 'time_slots', 'price_rules'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND to_regclass('bb.' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA bb', t);
    END IF;
  END LOOP;
  IF to_regtype('public.user_role') IS NOT NULL AND to_regtype('bb.user_role') IS NULL THEN
    ALTER TYPE public.user_role SET SCHEMA bb;
  END IF;
  IF to_regprocedure('public.forbid_change()') IS NOT NULL AND to_regprocedure('bb.forbid_change()') IS NULL THEN
    ALTER FUNCTION public.forbid_change() SET SCHEMA bb;
  END IF;
  IF to_regprocedure('public.forbid_delete()') IS NOT NULL AND to_regprocedure('bb.forbid_delete()') IS NULL THEN
    ALTER FUNCTION public.forbid_delete() SET SCHEMA bb;
  END IF;
END $$;

-- Idempotent hardening. EVERY later migration must end with `SELECT bb.harden_schema();`
-- (a test fails if any table in `bb` has row security off or grants to the API roles).
CREATE OR REPLACE FUNCTION harden_schema() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
  api_role text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'bb' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE bb.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  REVOKE ALL ON SCHEMA bb FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA bb FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA bb FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bb FROM PUBLIC;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA bb FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA bb FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA bb FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bb FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bb REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bb REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bb REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

SELECT harden_schema();
