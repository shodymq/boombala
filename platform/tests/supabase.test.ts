import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { authenticate } from "../src/core/auth.ts";
import { catalogSummary, resolvePrice, setPriceRule } from "../src/core/catalog.ts";
import { createPool, sslFor } from "../src/core/db.ts";
import { migrate } from "../src/core/migrate.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { createUser } from "../src/core/users.ts";
import { MIGRATIONS_DIR, seedFromSite, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

const API_ROLES = ["anon", "authenticated", "service_role"] as const;

describe("Supabase safety: closed schema, row security, pooler compatibility", () => {
  let db: TestDb;
  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
  });
  after(async () => {
    await db.stop();
  });

  it("every table lives in the closed schema `bb` and has row security ON (guards all future migrations too)", async () => {
    const { rows } = await db.pool.query<{ schema: string; name: string; rls: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
    );
    assert.ok(rows.length >= 9);
    assert.deepEqual(rows.filter((r) => r.schema !== "bb"), [], "nothing may be created outside bb");
    assert.deepEqual(rows.filter((r) => !r.rls).map((r) => r.name), [], "RLS must be on for every table");
  });

  it("the API roles (anon / authenticated / service_role) cannot touch any table, even though Supabase grants them rights on public", async () => {
    const { rows: tables } = await db.pool.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r'",
    );
    for (const role of API_ROLES) {
      for (const t of tables) {
        for (const sql of [`SELECT 1 FROM bb.${t.relname} LIMIT 1`, `DELETE FROM bb.${t.relname}`, `UPDATE bb.${t.relname} SET id = id`]) {
          const client = await db.pool.connect();
          try {
            await client.query(`SET ROLE ${role}`);
            await assert.rejects(() => client.query(sql), /permission denied/, `${role}: ${sql}`);
          } finally {
            await client.query("RESET ROLE");
            client.release();
          }
        }
      }
    }
  });

  it("even if someone grants table rights to anon by mistake, row security still returns nothing", async () => {
    await createUser(db.pool, null, { email: "rls@example.test", name: "RLS", role: "owner", password: TEST_PASSWORD });
    await db.pool.query("GRANT USAGE ON SCHEMA bb TO anon; GRANT SELECT ON bb.users TO anon");
    const client = await db.pool.connect();
    try {
      await client.query("SET ROLE anon");
      const res = await client.query("SELECT * FROM bb.users");
      assert.equal(res.rowCount, 0, "RLS without a policy hides every row");
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
    await db.pool.query("SELECT bb.harden_schema()"); // the hardening function undoes the mistake
    const again = await db.pool.connect();
    try {
      await again.query("SET ROLE anon");
      await assert.rejects(() => again.query("SELECT * FROM bb.users"), /permission denied/);
    } finally {
      await again.query("RESET ROLE");
      again.release();
    }
  });

  it("a table created later without hardening is detected by the guard query (and fixed by harden_schema)", async () => {
    await db.pool.query("CREATE TABLE bb.forgotten (id int)");
    const find = () => db.pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r' AND NOT c.relrowsecurity");
    assert.deepEqual((await find()).rows.map((r) => r.relname), ["forgotten"]);
    await db.pool.query("SELECT bb.harden_schema()");
    assert.deepEqual((await find()).rows, []);
    await db.pool.query("DROP TABLE bb.forgotten");
  });

  it("all application SQL is schema-qualified: the whole core works on a connection WITHOUT any search_path (as through a transaction pooler)", async () => {
    const strict = createPool(db.url, { max: 2 }); // no search_path option on purpose
    try {
      const user = await createUser(strict, null, { email: "pooler@example.test", name: "Pooler", role: "owner", password: TEST_PASSWORD });
      const login = await authenticate(strict, { email: "pooler@example.test", password: TEST_PASSWORD, ip: "10.9.0.1" });
      assert.ok(login.ok);
      if (!login.ok) return;
      assert.equal((await validateSession(strict, login.token))?.user.id, user.id);
      assert.ok(await createSession(strict, user.id));
      await setPriceRule(strict, { id: user.id, role: "owner" }, { packageId: "wow-party", ruleType: "date", date: "2027-05-01", amountKzt: 40000 });
      assert.deepEqual(await resolvePrice(strict, "wow-party", "2027-05-01"), { amountKzt: 40000, source: "date" });
      assert.equal((await catalogSummary(strict)).packages.length, 3);
    } finally {
      await strict.end();
    }
  });

  it("upgrades a Stage-1 database (tables in public, tracking table in public) in place without losing data", async () => {
    const legacy = await startTestDb({ migrate: false });
    try {
      // Emulate the first runner: run 001 and 002 in the default schema and record them in public.schema_migrations.
      const plain = createPool(legacy.url, { max: 1 });
      await plain.query("CREATE TABLE public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^00[12]_/.test(x)).sort()) {
        const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        await plain.query(sql);
        await plain.query("INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)", [f, createHash("sha256").update(sql).digest("hex")]);
      }
      await plain.query("INSERT INTO public.packages (id, name) VALUES ('keep-me', 'Keep me')");
      await plain.query("INSERT INTO public.price_rules (package_id, rule_type, amount_kzt) VALUES ('keep-me', 'base', 12345)");
      await plain.end();

      const res = await migrate(legacy.pool, MIGRATIONS_DIR);
      assert.ok(res.applied.includes("003_private_schema.sql"));
      assert.ok(!res.applied.includes("001_core.sql"), "already applied migrations are not run again");
      const { rows } = await legacy.pool.query("SELECT (SELECT count(*)::int FROM bb.packages WHERE id = 'keep-me') p, (SELECT amount_kzt FROM bb.price_rules WHERE package_id = 'keep-me') a, to_regclass('public.users') pu, to_regclass('public.schema_migrations') ps");
      assert.equal(rows[0].p, 1);
      assert.equal(rows[0].a, 12345);
      assert.equal(rows[0].pu, null);
      assert.equal(rows[0].ps, null);
      assert.equal((await legacy.pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')")).rows[0].n, 0);
      assert.equal((await legacy.pool.query("SELECT bool_and(c.relrowsecurity) ok FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r'")).rows[0].ok, true);
    } finally {
      await legacy.stop();
    }
  });

  it("TLS policy: local needs none; a remote database must be verified (CA) or the opt-out must be explicit", () => {
    assert.equal(sslFor("postgres://u:p@localhost:5432/db", {}), false);
    assert.equal(sslFor("postgres://u:p@127.0.0.1:5432/db", {}), false);
    const remote = "postgres://postgres.abc:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    assert.throws(() => sslFor(remote, {}), /DATABASE_CA_CERT/);
    assert.deepEqual(sslFor(remote, { DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----" }), {
      ca: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
      rejectUnauthorized: true,
    });
    assert.deepEqual(sslFor(remote, { DATABASE_SSL: "no-verify" }), { rejectUnauthorized: false });
    assert.throws(() => sslFor("not a url", {}), /valid URL/);
  });
});
