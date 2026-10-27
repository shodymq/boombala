// Break-glass: revokes EVERY Face ID / Touch ID key of ONE staff member (lost phone, a leaver) and ends their sessions. Audited
// (actor: server console). Password + second factor keep working; the person can add a new device from "Мой пароль".
// Run on the server by an administrator, over the VPN or the hosting console.
//   DATABASE_URL=... npm run passkeys:revoke -- --email owner@example.org
import { createPool } from "../src/core/db.ts";
import { revokePasskeysByEmail } from "../src/core/passkeys.ts";

const i = process.argv.indexOf("--email");
const email = i > 0 ? process.argv[i + 1] : undefined;
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error("Usage: DATABASE_URL=... npm run passkeys:revoke -- --email <email>");
  process.exit(1);
}
const pool = createPool(url, { max: 1 });
try {
  const r = await revokePasskeysByEmail(pool, email);
  console.log(r.found ? `Revoked ${r.revoked} key(s); sessions ended.` : "No such user.");
  process.exitCode = r.found ? 0 : 2;
} finally {
  await pool.end();
}
