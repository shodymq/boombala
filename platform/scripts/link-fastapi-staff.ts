// Links a Platform staff account to its FastAPI AdminUser (the id printed by FastAPI, 32 hex characters). The calendar bridge
// refuses any staff account without this link. Run by an administrator on the server; the value is never guessed from e-mail.
//   DATABASE_URL=... npm run user:link-fastapi -- --email manager@example.org --admin-user-id <id>
//   DATABASE_URL=... npm run user:link-fastapi -- --email manager@example.org --unlink
import { createPool } from "../src/core/db.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = value("--email")?.trim().toLowerCase();
const adminUserId = value("--admin-user-id")?.trim();
const unlink = args.includes("--unlink");
const url = process.env.DATABASE_URL;

if (!email || !url || (!unlink && !adminUserId) || (unlink && adminUserId)) {
  console.error("Usage: DATABASE_URL=... npm run user:link-fastapi -- --email <email> (--admin-user-id <id> | --unlink)");
  process.exit(1);
}
if (adminUserId && !/^[A-Za-z0-9_-]{1,64}$/.test(adminUserId)) {
  console.error("admin-user-id has an unexpected format");
  process.exit(1);
}

const pool = createPool(url, { max: 1 });
try {
  const { rowCount } = await pool.query(
    "UPDATE bb.users SET fastapi_admin_user_id = $2, updated_at = now() WHERE email = $1",
    [email, unlink ? null : adminUserId],
  );
  console.log(rowCount ? (unlink ? "unlinked" : "linked") : "no such user");
  process.exitCode = rowCount ? 0 : 2;
} finally {
  await pool.end();
}
