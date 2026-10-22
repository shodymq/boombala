// Break-glass: sets a new password for ONE staff member from the server console and ends their sessions. For a locked-out
// Owner when no other Owner can reset it. The password is read from a hidden prompt, never from the command line.
//   DATABASE_URL=... npm run user:set-password -- --email owner@example.org
import { createInterface } from "node:readline";
import { createPool } from "../src/core/db.ts";
import { ValidationError } from "../src/core/errors.ts";
import { resetPasswordFromConsole } from "../src/core/users.ts";

const i = process.argv.indexOf("--email");
const email = i > 0 ? process.argv[i + 1] : undefined;
const url = process.env.DATABASE_URL;
if (!email || !url) {
  console.error("Usage: DATABASE_URL=... npm run user:set-password -- --email <email>");
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

const password = process.env.BB_PASSWORD ?? (await askHidden("New password (min 12 characters, input is hidden): "));
const pool = createPool(url, { max: 1 });
try {
  const done = await resetPasswordFromConsole(pool, email, password);
  console.log(done ? "Password changed; all sessions of this person ended." : "No such user.");
  process.exitCode = done ? 0 : 2;
} catch (error) {
  if (error instanceof ValidationError) console.error("invalid:", JSON.stringify(error.fields));
  else throw error;
  process.exitCode = 1;
} finally {
  await pool.end();
}
