// Ends staff sessions from the server console and writes one audit entry (actor: the console).
//   DATABASE_URL=... npm run sessions:revoke -- --without-mfa   (the ones that did not pass the second factor: run when MFA_MODE becomes "required")
//   DATABASE_URL=... npm run sessions:revoke -- --all           (everybody, e.g. after a suspected leak)
import { createPool } from "../src/core/db.ts";
import { writeAudit } from "../src/core/audit.ts";
import { revokeAllSessions, revokeSessionsWithoutMfa } from "../src/core/session.ts";

const mode = process.argv.includes("--all") ? "all" : process.argv.includes("--without-mfa") ? "without_mfa" : null;
const url = process.env.DATABASE_URL;
if (!mode || !url) {
  console.error("Usage: DATABASE_URL=... npm run sessions:revoke -- --without-mfa | --all");
  process.exit(1);
}
const pool = createPool(url, { max: 1 });
try {
  const ended = mode === "all" ? await revokeAllSessions(pool) : await revokeSessionsWithoutMfa(pool);
  await writeAudit(pool, { actorUserId: null, action: "session.revoked_bulk", entityType: "session", after: { mode, ended, via: "server_console" } });
  console.log(`${ended} session(s) ended (${mode}).`);
} finally {
  await pool.end();
}
