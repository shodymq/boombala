// Read-only verification of the REAL database roles (nothing is written, no sequence value is consumed):
//   API_DATABASE_URL=… ADMIN_DATABASE_URL=… npm run verify:roles
// The public API role must be refused on every table with personal data, on the sequences, on DDL and on the maintenance function;
// the staff role must work with the data but be refused on DELETE of protected history, on TRUNCATE and on DDL. Output: codes and names only.
import pg from "pg";
import { sslFor } from "./lib/bb-export.mjs";

const apiUrl = process.env.API_DATABASE_URL;
const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!apiUrl || !adminUrl) throw new Error("API_DATABASE_URL and ADMIN_DATABASE_URL are required");
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
const connect = async (u) => {
  const c = new pg.Client({ connectionString: u, ssl: sslFor(u) });
  await c.connect();
  return c;
};
/** Runs a statement and returns its SQLSTATE ("ok" when it succeeded). A failed statement aborts only its own savepoint. */
const state = async (c, sql) => {
  await c.query("BEGIN");
  try {
    await c.query(sql);
    return "ok";
  } catch (e) {
    return e.code ?? "error";
  } finally {
    await c.query("ROLLBACK");
  }
};
const DENIED = "42501";

const api = await connect(apiUrl);
const admin = await connect(adminUrl);
try {
  ok((await api.query("SELECT current_user u")).rows[0].u === "bb_api", "connected as bb_api");
  ok((await admin.query("SELECT current_user u")).rows[0].u === "bb_admin", "connected as bb_admin");
  const attrs = (await api.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname IN ('bb_api', 'bb_admin')")).rows;
  ok(attrs.length === 2 && attrs.every((r) => !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolbypassrls), "both roles are plain (no superuser, no DDL, no role creation, no row-security bypass)");

  const closed = ["contacts", "lead_requests", "consent_events", "consent_registrations", "outbox", "audit_log", "sessions", "users", "user_mfa", "mfa_recovery_codes", "export_log", "retention_settings", "login_attempts", "schema_migrations", "attendance_entries", "attendance_corrections"];
  for (const t of closed) ok((await state(api, `SELECT count(*) FROM bb.${t}`)) === DENIED, `bb_api cannot read bb.${t}`);
  ok((await state(api, "INSERT INTO bb.contacts (name, name_key, source) VALUES ('x', 'x', 'qr')")) === DENIED, "bb_api cannot insert into bb.contacts");
  ok((await state(api, "SELECT contact_id FROM bb.slot_reservations LIMIT 1")) === DENIED, "bb_api cannot read the customer column of slot_reservations");
  const seqs = (await api.query("SELECT sequencename FROM pg_sequences WHERE schemaname = 'bb' ORDER BY 1")).rows.map((r) => r.sequencename);
  for (const s of seqs) ok((await state(api, `SELECT nextval('bb.${s}')`)) === DENIED, `bb_api cannot draw from bb.${s}`);
  ok((await state(api, "SELECT bb.harden_schema()")) === DENIED, "bb_api cannot run bb.harden_schema");
  ok((await state(api, "CREATE TABLE bb.zz_probe (a int)")) === DENIED, "bb_api cannot create objects");
  const fnExec = (await api.query("SELECT p.proname, has_function_privilege('bb_api', p.oid, 'EXECUTE') AS x FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname LIKE 'intake\\_%'")).rows;
  ok(fnExec.length === 9 && fnExec.every((r) => r.x), "bb_api may execute exactly the nine intake_* functions");
  const others = (await api.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname NOT LIKE 'intake\\_%' AND has_function_privilege('bb_api', p.oid, 'EXECUTE')")).rows[0].n;
  ok(others === 0, "bb_api may execute no other function of the schema");
  const secdef = (await api.query("SELECT bool_and(prosecdef) s, bool_and(proconfig::text LIKE '%search_path=pg_catalog, bb%') p FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname LIKE 'intake\\_%'")).rows[0];
  ok(secdef.s && secdef.p, "the intake functions are SECURITY DEFINER with a fixed search_path");
  ok((await api.query("SELECT count(*)::int n FROM bb.legal_documents WHERE status <> 'published'")).rows[0].n === 0, "bb_api sees published documents only");

  ok((await state(admin, "SELECT count(*) FROM bb.contacts")) === "ok", "bb_admin reads the application data");
  for (const t of ["audit_log", "consent_events", "contacts", "lead_requests", "legal_documents", "slot_reservations", "attendance_entries", "attendance_corrections", "consent_registrations"]) {
    ok((await state(admin, `DELETE FROM bb.${t} WHERE false`)) === DENIED, `bb_admin cannot DELETE from bb.${t}`);
  }
  ok((await state(admin, "TRUNCATE bb.contacts")) === DENIED, "bb_admin cannot TRUNCATE");
  ok((await state(admin, "CREATE TABLE bb.zz_probe (a int)")) === DENIED, "bb_admin cannot create objects");
  ok((await state(admin, "ALTER TABLE bb.sessions DROP COLUMN mfa_verified_at")) === DENIED, "bb_admin cannot alter tables");
  ok((await state(admin, "SELECT bb.harden_schema()")) === DENIED, "bb_admin cannot run bb.harden_schema");
  ok((await admin.query("SELECT has_function_privilege('bb_admin', p.oid, 'EXECUTE') x FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname = 'intake_insert_registration'")).rows.every((r) => !r.x), "bb_admin does not use the public intake functions");
} finally {
  await api.end();
  await admin.end();
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
