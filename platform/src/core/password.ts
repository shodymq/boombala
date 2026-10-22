import { hash, verify } from "@node-rs/argon2";

/** argon2id, OWASP 2023 minimum profile (19 MiB, 2 passes, 1 lane). */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns the same CPU as a real check, so "no such user" is not faster than "wrong password". */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-account-password");
  await verifyPassword(await dummyHash, password);
}
