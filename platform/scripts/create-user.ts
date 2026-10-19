// Creates a staff user. The password is read from a hidden prompt (or BB_PASSWORD for automation), never from argv.
//   npm run user:create -- --email owner@boombala.kz --name "Имя" --role owner
import { createInterface } from "node:readline";
import { createPool } from "../src/core/db.ts";
import { isRole } from "../src/core/rbac.ts";
import { ConflictError, ValidationError } from "../src/core/errors.ts";
import { createUser } from "../src/core/users.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, "") ?? "", process.argv[i + 1] ?? "");
const email = args.get("email");
const name = args.get("name");
const role = args.get("role");
if (!email || !name || !role || !isRole(role)) {
  console.error('Usage: npm run user:create -- --email <email> --name "<name>" --role owner|manager|editor');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { _hide?: boolean };
    const write = out.write.bind(out);
    out.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (out._hide ? true : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof out.write;
    rl.question(question, (answer) => {
      out._hide = false;
      out.write = write;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    out._hide = true;
  });
}

const password = process.env.BB_PASSWORD ?? (await askHidden("Password (min 12 characters, input is hidden): "));
const pool = createPool(url, 2);
try {
  const user = await createUser(pool, null, { email, name, role, password });
  console.log(`created ${user.role} ${user.email} (${user.id})`);
} catch (error) {
  if (error instanceof ValidationError) console.error("invalid:", JSON.stringify(error.fields));
  else if (error instanceof ConflictError) console.error("a user with this e-mail already exists");
  else throw error;
  process.exitCode = 1;
} finally {
  await pool.end();
}
