-- 005_function_search_path: every function in `bb` gets a fixed search_path (Supabase security advisor
-- "function_search_path_mutable"). harden_schema() now does this for all current AND future functions, so every
-- later migration that ends with `SELECT bb.harden_schema();` keeps the rule. Plain PostgreSQL compatible.
CREATE OR REPLACE FUNCTION harden_schema() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
  api_role text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'bb' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE bb.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'bb' AND p.prokind = 'f' AND p.proconfig IS NULL LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, bb', r.sig);
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
