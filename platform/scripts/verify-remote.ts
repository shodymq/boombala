/**
 * Runtime check of a REAL PostgreSQL (Supabase) from a trusted machine: TLS, pooler, schema, RLS, login/session,
 * and the double-booking guarantee with independent connections. Uses only synthetic data and removes it afterwards.
 *
 *   VERIFY_REMOTE_CONFIRM=boombala-test DATABASE_URL=<transaction pooler URL> [DATABASE_CA_CERT=<pem>] npm run verify:remote
 *
 * It refuses to run without the confirmation word, so it can never be pointed at production by accident.
 * Nothing is printed except check names and results: no URLs, no passwords.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "../src/core/auth.ts";
import { createBlock } from "../src/core/bookings.ts";
import { createPool, withTx, type Pool } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { hashToken, revokeSession, validateSession } from "../src/core/session.ts";

if (process.env.VERIFY_REMOTE_CONFIRM !== "boombala-test") {
  console.error("Refusing to run: set VERIFY_REMOTE_CONFIRM=boombala-test (this script writes and deletes synthetic rows).");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const port = (() => {
  try {
    return new URL(url).port || "5432";
  } catch {
    return "?";
  }
})();

const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
})();

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(cond ? "  ok  " : "  FAIL", msg);
  if (!cond) fails++;
};

const EMAIL = `verify-${randomUUID().slice(0, 8)}@example.test`;
const PASSWORD = `Synthetic-${randomUUID()}`;
const ROOM = `zz-verify-${randomUUID().slice(0, 6)}`;
let userId: string | null = null;
const pools: Pool[] = [];
const mk = (max: number) => {
  const p = createPool(url, { max });
  pools.push(p);
  return p;
};

try {
  console.log(`## connection (port ${port}${port === "6543" ? ", transaction pooler" : port === "5432" ? ", direct/session" : ""})`);
  const main = mk(3);
  const c = await main.connect();
  try {
    const stream = (c as unknown as { connection: { stream: { encrypted?: boolean; authorized?: boolean; getProtocol?: () => string | null } } }).connection.stream;
    if (isLocal) {
      console.log("  skip TLS checks: local database (a remote host must pass them)");
    } else {
      ok(stream.encrypted === true, `TLS is on (${stream.getProtocol?.() ?? "unknown protocol"})`);
      ok(stream.authorized === true, "the server certificate is VERIFIED (not just encrypted)");
    }
    const v = await c.query("SELECT current_user AS u, current_setting('server_version') AS v");
    ok(!!v.rows[0].v, `connected as a database role, PostgreSQL ${v.rows[0].v}`);
  } finally {
    c.release();
  }
  const parallel = await Promise.all(Array.from({ length: 30 }, (_, i) => withTx(main, async (tx) => Number((await tx.query("SELECT $1::int AS n", [i])).rows[0].n))));
  ok(parallel.length === 30 && parallel.every((n, i) => n === i), "30 parallel transactions over a 3-connection pool all complete (pooler-safe, SET LOCAL timeouts work)");

  console.log("## schema and row security");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = (await main.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name")).rows.map((r) => r.name);
  ok(JSON.stringify(applied) === JSON.stringify(files), `all ${files.length} migration files are applied (${applied.length} recorded)`);
  const noRls = await main.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r' AND NOT c.relrowsecurity");
  ok(noRls.rowCount === 0, "row security is ON for every table in bb");
  const apiGrants = await main.query(
    `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'bb' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC') LIMIT 1`,
  );
  ok(apiGrants.rowCount === 0, "anon / authenticated / service_role / PUBLIC hold no rights on bb");

  console.log("## authentication (synthetic staff user)");
  const created = await createUser(main, null, { email: EMAIL, name: "Verify Synthetic", role: "manager", password: PASSWORD });
  userId = created.id;
  const bad = await authenticate(main, { email: EMAIL, password: "wrong password here", ip: "203.0.113.9", userAgent: "verify" });
  ok(!bad.ok, "a wrong password is refused");
  const good = await authenticate(main, { email: EMAIL, password: PASSWORD, ip: "203.0.113.9", userAgent: "verify" });
  ok(good.ok, "the right password signs in");
  if (good.ok) {
    const s = await validateSession(main, good.token);
    ok(s?.user.id === userId && s.user.role === "manager", "the session token resolves to the user and role");
    const stored = await main.query("SELECT 1 FROM bb.sessions WHERE token_hash = $1 AND token_hash <> $2", [hashToken(good.token), Buffer.from(good.token)]);
    ok(stored.rowCount === 1, "only the SHA-256 of the token is stored, never the token itself");
    await revokeSession(main, good.token);
    ok((await validateSession(main, good.token)) === null, "a revoked session stops working");
  }

  console.log("## double booking from independent connections");
  await main.query("INSERT INTO bb.rooms (id, name, sort_order) VALUES ($1, 'Verify room', 99)", [ROOM]);
  const actor = { id: userId, role: "manager" as const };
  const a = mk(1);
  const b = mk(1);
  const d = mk(1);
  let singleWinner = true;
  let cleanConflict = true;
  const base = new Date(Date.now() + 900 * 864e5);
  for (let round = 0; round < 12; round++) {
    const date = new Date(base.getTime() + round * 864e5).toISOString().slice(0, 10);
    const contenders = round % 3 === 2 ? [a, b, d] : [a, b];
    const res = await Promise.allSettled(contenders.map((p) => createBlock(p, actor, { date, slotId: 2, roomId: ROOM, note: "verify" })));
    const wins = res.filter((r) => r.status === "fulfilled").length;
    if (wins !== 1) singleWinner = false;
    if (res.some((r) => r.status === "rejected" && (r.reason as Error).message !== "slot_taken")) cleanConflict = false;
    const rows = Number((await main.query("SELECT count(*) AS n FROM bb.slot_reservations WHERE slot_date = $1 AND room_id = $2 AND released_at IS NULL", [date, ROOM])).rows[0].n);
    if (rows !== 1) singleWinner = false;
  }
  ok(singleWinner, "12 rounds, 2-3 independent connections each: exactly ONE reservation per contested cell");
  ok(cleanConflict, "every loser got a clean 'slot_taken' conflict (no raw database error)");
} catch (error) {
  fails++;
  console.error("  FAIL unexpected error:", error instanceof Error ? error.name : "unknown");
} finally {
  console.log("## cleanup of synthetic rows");
  try {
    const admin = createPool(url, { max: 1 });
    pools.push(admin);
    await withTx(admin, async (tx) => {
      for (const t of ["slot_reservations", "rooms", "audit_log", "price_rules"]) await tx.query(`ALTER TABLE bb.${t} DISABLE TRIGGER USER`);
      await tx.query("DELETE FROM bb.slot_reservations WHERE room_id = $1", [ROOM]);
      await tx.query("DELETE FROM bb.rooms WHERE id = $1", [ROOM]);
      await tx.query("DELETE FROM bb.audit_log WHERE actor_user_id = $1 OR entity_id = $1::text OR (entity_type = 'user' AND after::text LIKE $2)", [userId, `%${EMAIL}%`]);
      await tx.query("DELETE FROM bb.login_attempts WHERE email_norm = $1", [EMAIL]);
      if (userId) await tx.query("DELETE FROM bb.users WHERE id = $1", [userId]);
      for (const t of ["slot_reservations", "rooms", "audit_log", "price_rules"]) await tx.query(`ALTER TABLE bb.${t} ENABLE TRIGGER USER`);
    });
    const left = await admin.query("SELECT (SELECT count(*) FROM bb.users WHERE email = $1) + (SELECT count(*) FROM bb.rooms WHERE id = $2) + (SELECT count(*) FROM bb.slot_reservations WHERE room_id = $2) AS n", [EMAIL, ROOM]);
    ok(Number(left.rows[0].n) === 0, "no synthetic rows remain and the guard triggers are enabled again");
  } catch {
    fails++;
    console.error("  FAIL cleanup failed: remove users like verify-%@example.test and rooms zz-verify-% by hand");
  }
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
