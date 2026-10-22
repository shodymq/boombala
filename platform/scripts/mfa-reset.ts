// Break-glass: removes the second factor of ONE staff member (lost phone and no recovery codes), ends their sessions,
// and writes an audit entry (actor: server console). Run on the server by an administrator, over the VPN or the hosting
// console. The person enrols again at the next login.
//   DATABASE_URL=... npm run user:mfa-reset -- --email owner@example.org
import { createPool } from "../src/core/db.ts";
import { resetUserMfaByEmail } from "../src/core/mfa.ts";

const i = process.argv.indexOf("--email");
const email = i > 0 ? process.argv[i + 1] : undefined;
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error("Usage: DATABASE_URL=... npm run user:mfa-reset -- --email <email>");
  process.exit(1);
}
const pool = createPool(url, { max: 1 });
try {
  const done = await resetUserMfaByEmail(pool, email);
  console.log(done ? "Second factor removed; sessions ended. The person enrols again at the next login." : "No such user.");
  process.exitCode = done ? 0 : 2;
} finally {
  await pool.end();
}
