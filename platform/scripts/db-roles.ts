// Database roles of the Kazakhstan deployment: one per application, each with only what it needs.
//   BB_API_PASSWORD=... BB_ADMIN_PASSWORD=... DATABASE_URL=<owner connection> npm run db:roles
// Run it AFTER every migration run (it is idempotent; a new table is unreachable for the application roles until
// it is classified in the lists below, and a test fails until it is).
//
//   bb_owner (not created here)  owns the objects and runs migrations; no application connects as it.
//   bb_admin                     the staff application: data access on every table, no DDL, no TRUNCATE.
//   bb_api                       the public API: insert-only intake, read-only public data. No access to staff, sessions,
//                                MFA, export log, retention settings, audit reads.
// Row security is ON for every table (harden_schema); the owner bypasses it, other roles need a policy, created here.
import type { Pool } from "../src/core/db.ts";

export interface ApiTable {
  privileges: string;
  /** Row filter: the API role sees only these rows (a draft or an unpublished post does not exist for it). */
  using?: string;
}

/**
 * What the public API role may read directly: PUBLIC data only. It has NO privilege on contacts, enquiries, consent
 * registrations or history, the notification queue or the audit log: personal data is written only through the narrow
 * `bb.intake_*` functions (migration 012), which return one row per call and never a name or a phone.
 */
export const API_GRANTS: Record<string, ApiTable> = {
  legal_documents: { privileges: "SELECT", using: "status = 'published'" },
  packages: { privileges: "SELECT" },
  rooms: { privileges: "SELECT" },
  time_slots: { privileges: "SELECT" },
  price_rules: { privileges: "SELECT" },
  // free/busy only: which cell is taken, never who took it or for how much
  slot_reservations: { privileges: "SELECT (slot_date, slot_id, room_id, released_at)" },
  news_posts: { privileges: "SELECT", using: "status = 'published' AND published_at <= now()" },
  news_images: {
    privileges: "SELECT",
    using: "EXISTS (SELECT 1 FROM bb.news_posts p WHERE p.status = 'published' AND p.published_at <= now() AND (p.cover_image_id = news_images.id OR position('img:' || news_images.id::text in lower(p.body)) > 0))",
  },
};

/** The only functions the API role may execute. */
export const API_FUNCTION_PREFIX = "intake_";

/** Tables the staff application may delete from (everything else is append-only or never deleted). */
export const ADMIN_DELETE = ["sessions", "login_attempts", "user_mfa", "mfa_recovery_codes", "news_posts", "news_images"] as const;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface RoleOptions {
  apiPassword: string;
  adminPassword: string;
  apiRole?: string;
  adminRole?: string;
}

async function ensureRole(pool: Pool, role: string, password: string, limit: number, statementTimeout: string): Promise<void> {
  if (password.length < 24) throw new Error(`password for ${role} must be at least 24 characters`);
  const exists = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  const lit = (await pool.connect().then(async (c) => { try { return c.escapeLiteral(password); } finally { c.release(); } }));
  const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit} PASSWORD ${lit}`;
  await pool.query(exists ? `ALTER ROLE ${ident(role)} ${attrs}` : `CREATE ROLE ${ident(role)} ${attrs}`);
  await pool.query(`ALTER ROLE ${ident(role)} SET statement_timeout = '${statementTimeout}'`);
  await pool.query(`ALTER ROLE ${ident(role)} SET idle_in_transaction_session_timeout = '15s'`);
}

export async function applyRoles(pool: Pool, opts: RoleOptions): Promise<{ api: string; admin: string; tables: string[] }> {
  const api = opts.apiRole ?? "bb_api";
  const admin = opts.adminRole ?? "bb_admin";
  await ensureRole(pool, api, opts.apiPassword, 20, "5s");
  await ensureRole(pool, admin, opts.adminPassword, 20, "30s");
  const tables = (await pool.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r' ORDER BY 1")).rows.map((r) => r.t);
  for (const t of Object.keys(API_GRANTS)) if (!tables.includes(t)) throw new Error(`API_GRANTS names a table that does not exist: ${t}`);
  for (const t of ADMIN_DELETE) if (!tables.includes(t)) throw new Error(`ADMIN_DELETE names a table that does not exist: ${t}`);

  for (const role of [api, admin]) {
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA bb FROM ${ident(role)}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA bb FROM ${ident(role)}`);
    await pool.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bb FROM ${ident(role)}`);
    await pool.query(`REVOKE ALL ON SCHEMA public FROM ${ident(role)}`);
    await pool.query(`GRANT USAGE ON SCHEMA bb TO ${ident(role)}`);
    for (const t of tables) await pool.query(`DROP POLICY IF EXISTS ${ident(`${role}_access`)} ON bb.${ident(t)}`);
  }
  // Sequences: the staff application writes through ordinary INSERTs (serial columns need USAGE). The public API role gets
  // NONE: every write it makes happens inside the intake functions, which run as their owner. It cannot draw, read or set a counter.
  await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA bb TO ${ident(admin)}`);
  for (const [t, { privileges, using }] of Object.entries(API_GRANTS)) {
    await pool.query(`GRANT ${privileges} ON bb.${ident(t)} TO ${ident(api)}`);
    await pool.query(`CREATE POLICY ${ident(`${api}_access`)} ON bb.${ident(t)} FOR SELECT TO ${ident(api)} USING (${using ?? "true"})`);
  }
  const fns = (await pool.query<{ sig: string }>("SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname LIKE $1", [`${API_FUNCTION_PREFIX}%`])).rows;
  if (fns.length === 0) throw new Error("no bb.intake_* functions found: apply migration 012 first");
  for (const f of fns) await pool.query(`GRANT EXECUTE ON FUNCTION ${f.sig} TO ${ident(api)}`);
  for (const t of tables) {
    await pool.query(`GRANT SELECT, INSERT, UPDATE ON bb.${ident(t)} TO ${ident(admin)}`);
    if ((ADMIN_DELETE as readonly string[]).includes(t)) await pool.query(`GRANT DELETE ON bb.${ident(t)} TO ${ident(admin)}`);
    await pool.query(`CREATE POLICY ${ident(`${admin}_access`)} ON bb.${ident(t)} FOR ALL TO ${ident(admin)} USING (true) WITH CHECK (true)`);
  }
  return { api, admin, tables };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPool } = await import("../src/core/db.ts");
  const url = process.env.DATABASE_URL;
  const apiPassword = process.env.BB_API_PASSWORD;
  const adminPassword = process.env.BB_ADMIN_PASSWORD;
  if (!url || !apiPassword || !adminPassword) {
    console.error("DATABASE_URL (owner), BB_API_PASSWORD and BB_ADMIN_PASSWORD are required");
    process.exit(1);
  }
  const pool = createPool(url, { max: 2 });
  try {
    const r = await applyRoles(pool, { apiPassword, adminPassword });
    console.log(`roles ready: ${r.api}, ${r.admin}; ${r.tables.length} tables classified`);
  } finally {
    await pool.end();
  }
}
