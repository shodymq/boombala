import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./db.ts";

const LOCK_KEY = 727_001; // arbitrary, only used to serialise concurrent migrators

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies `*.sql` files in name order, each in its own transaction, once.
 * A file that was already applied and has since been edited is a hard error (checksum).
 * Never run against production without the owner's approval (see docs/platform/OPERATIONS.md).
 */
export async function migrate(pool: Pool, dir: string): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const known = done.get(file);
      if (known) {
        if (known !== checksum) throw new Error(`Migration ${file} was changed after it was applied`);
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
