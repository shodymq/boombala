// Break-glass / first access from the server console: issues a ONE-TIME enrolment code for a person who has no second factor
// (a new employee, or after `user:mfa-reset`, or an Owner who lost every device). The code is printed ONCE and stored only as a hash.
// With it, after the password, the person enrols the authenticator app (and then Face ID / Touch ID). A password alone is never enough.
// Audited (actor: server console). Run on the server by an administrator, over the VPN or the hosting console.
//   DATABASE_URL=... npm run user:enrollment-code -- --email owner@example.org
import { createPool } from "../src/core/db.ts";
import { issueEnrollmentCodeByEmail } from "../src/core/enrollment.ts";

const i = process.argv.indexOf("--email");
const email = i > 0 ? process.argv[i + 1] : undefined;
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error("Usage: DATABASE_URL=... npm run user:enrollment-code -- --email <email>");
  process.exit(1);
}
const pool = createPool(url, { max: 1 });
try {
  const r = await issueEnrollmentCodeByEmail(pool, email);
  if (!r) {
    console.log("No such user.");
    process.exitCode = 2;
  } else {
    console.log(`Enrolment code (shown once, valid until ${r.expiresAt.toISOString()}): ${r.code}`);
  }
} catch (e) {
  console.error(e instanceof Error && e.message === "already_enrolled" ? "The person already has a second factor or a passkey: run user:mfa-reset first." : "Failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
