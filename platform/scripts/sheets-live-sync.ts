import { getPool } from "../src/server/db.ts";
import { runSheetsLiveSync } from "../src/server/sheets-live-sync.ts";

const pool = getPool();
const dryRun = process.argv.includes("--dry-run");
try {
  const result = await runSheetsLiveSync({ mode: dryRun ? "dry_run" : "auto", trigger: dryRun ? "dry_run" : "timer", pool });
  // Deliberately aggregate-only: no source cells, names, phones, tokens or raw exceptions reach stdout/journald.
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_]{1,60}$/.test(error.message) ? error.message : "sync_failed";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
