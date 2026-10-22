import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { authenticate } from "../src/core/auth.ts";
import { migrate } from "../src/core/migrate.ts";
import { createSession, validateSession } from "../src/core/session.ts";
import { makeUser, MIGRATIONS_DIR, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

/**
 * The shared Preview database (boombala-test) is at migration 010. Code that is pushed to `release/preview` must keep
 * working there until a newer migration is approved and applied: login, sessions, everything that does not need the second factor.
 */
describe("Compatibility with a database that has migrations only up to 010 (the current Preview)", () => {
  let db: TestDb;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "bbmig-"));
    mkdirSync(join(dir, "m"));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^(00\d|010)_/.test(x))) cpSync(join(MIGRATIONS_DIR, f), join(dir, "m", f));
    db = await startTestDb({ migrate: false });
    const res = await migrate(db.pool, join(dir, "m"));
    assert.equal(res.applied.length, 10);
  });
  after(async () => {
    await db.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("password login, session validation and sign-out work without the newer columns when the second factor is not mandatory", async () => {
    const u = await makeUser(db.pool, "owner", "compat.owner@example.test");
    const r = await authenticate(db.pool, { email: u.email, password: TEST_PASSWORD, ip: "10.0.0.1" });
    assert.ok(r.ok && r.mfa === "none");
    assert.equal((await validateSession(db.pool, r.token))?.user.id, u.id);
    const s = await createSession(db.pool, u.id, {});
    assert.ok(await validateSession(db.pool, s.token, { state: "verified" }));
  });

  it("the mandatory mode needs migration 011 and says so instead of silently letting anyone in", async () => {
    const u = await makeUser(db.pool, "manager", "compat.manager@example.test");
    const s = await createSession(db.pool, u.id, {});
    await assert.rejects(() => validateSession(db.pool, s.token, { requireMfa: true }), /mfa_verified_at/);
  });
});
