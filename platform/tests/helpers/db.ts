import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../../src/core/db.ts";
import { migrate } from "../../src/core/migrate.ts";
import { seedCatalog } from "../../src/core/seed.ts";
import { createUser } from "../../src/core/users.ts";
import type { Role } from "../../src/core/rbac.ts";
import { findFreePort, initCluster, startCluster, stopCluster } from "../../scripts/lib/cluster.mjs";
import { birthdayPackages } from "../../../src/data/birthdays.ts";
import { birthdayRooms } from "../../../src/data/birthdayRooms.ts";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** What a Supabase project has before our migrations: the API roles, and default grants on `public`. */
const SUPABASE_LIKE_ROLES = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`;

export interface TestDb {
  pool: Pool;
  url: string;
  /** Extra independent connection pool: concurrency tests need separate connections/sessions. */
  newPool(max?: number): Pool;
  stop(): Promise<void>;
}

/** A real, private PostgreSQL server (own data dir, own port) with all migrations applied. */
export async function startTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "bbpg-test-"));
  const data = join(dir, "data");
  const port = await findFreePort();
  initCluster(data);
  const socketDir = startCluster(data, port, { fast: true });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  // Raw SQL inside tests is unqualified; the application itself always qualifies (`bb.users`).
  const pool = createPool(url, { max: 10, searchPath: "bb,public" });
  const pools = [pool];
  await pool.query(SUPABASE_LIKE_ROLES);
  if (opts.migrate !== false) await migrate(pool, MIGRATIONS_DIR);
  return {
    pool,
    url,
    newPool: (max = 5) => {
      const p = createPool(url, { max, searchPath: "bb,public" });
      pools.push(p);
      return p;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
      stopCluster(data, socketDir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The same catalog the public site shows: ids, names and prices come from the site's own data files. */
export function seedFromSite(pool: Pool) {
  return seedCatalog(pool, {
    packages: birthdayPackages.map((p) => ({ id: p.id, name: p.name, price: p.price, weekdayPrice: p.weekdayPrice })),
    rooms: birthdayRooms.map((r) => ({ id: r.id, name: r.name })),
  });
}

export const TEST_PASSWORD = "correct horse battery staple";

export async function makeUser(pool: Pool, role: Role, email = `${role}@example.test`) {
  return createUser(pool, null, { email, name: `Test ${role}`, role, password: TEST_PASSWORD });
}
