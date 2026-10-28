import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastApiCrmError } from "../src/server/fastapi-crm.ts";
import { withFastApiClient, type CrmActorDeps } from "../src/server/crm-actor.ts";

// The client constructor reads the flag and the base URL at call time.
process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
process.env.FASTAPI_ADMIN_BASE_URL = "http://127.0.0.1:8000";

const staff = { id: "user-1", email: "manager-a@staging.boombala.example.com" };

/** Stand-in for the bridge: each issuance gets a new token and is recorded with the identity it was issued for. */
function bridge(link: { current: string | null }) {
  const issued: { identity: string; token: string }[] = [];
  const deps: CrmActorDeps = {
    linkFor: async () => link.current,
    issue: (async (who: { fastapiAdminUserId: string | null }) => {
      const token = `token-${issued.length + 1}`;
      issued.push({ identity: who.fastapiAdminUserId ?? "", token });
      return { accessToken: token, requestId: "r" };
    }) as CrmActorDeps["issue"],
  };
  return { deps, issued };
}

describe("withFastApiClient: identity and token lifecycle", () => {
  it("refuses an unlinked staff member before any token is requested", async () => {
    const link = { current: null as string | null };
    const { deps, issued } = bridge(link);
    await assert.rejects(
      withFastApiClient({ sessionId: "s-unlinked", user: staff }, async () => "never", deps),
      (error: unknown) => error instanceof FastApiCrmError && error.code === "staff_not_linked",
    );
    assert.equal(issued.length, 0);
  });

  it("reuses one token for the same session and identity", async () => {
    const link = { current: "stg-manager-a" as string | null };
    const { deps, issued } = bridge(link);
    await withFastApiClient({ sessionId: "s-reuse", user: staff }, async () => 1, deps);
    await withFastApiClient({ sessionId: "s-reuse", user: staff }, async () => 2, deps);
    assert.equal(issued.length, 1);
  });

  it("a relink to another identity never reuses the token issued for the old one", async () => {
    const link = { current: "stg-manager-a" as string | null };
    const { deps, issued } = bridge(link);
    await withFastApiClient({ sessionId: "s-relink", user: staff }, async () => 1, deps);
    link.current = "stg-manager-b";
    await withFastApiClient({ sessionId: "s-relink", user: staff }, async () => 2, deps);
    assert.deepEqual(issued.map((i) => i.identity), ["stg-manager-a", "stg-manager-b"]);
  });

  it("a 401 drops the token and retries once with a fresh one", async () => {
    const link = { current: "stg-manager-a" as string | null };
    const { deps, issued } = bridge(link);
    const tokens: string[] = [];
    const result = await withFastApiClient(
      { sessionId: "s-expired", user: staff },
      async (client) => {
        tokens.push((client as unknown as { actor: { accessToken: string } }).actor.accessToken);
        if (tokens.length === 1) throw new FastApiCrmError(401, "token_expired", "x");
        return "ok";
      },
      deps,
    );
    assert.equal(result, "ok");
    assert.equal(issued.length, 2);
    assert.notEqual(tokens[0], tokens[1], "the retry used a new token");
  });

  it("a second 401 is returned to the caller, not retried forever", async () => {
    const link = { current: "stg-manager-a" as string | null };
    const { deps, issued } = bridge(link);
    await assert.rejects(
      withFastApiClient({ sessionId: "s-revoked", user: staff }, async () => { throw new FastApiCrmError(401, "service_token_invalid", "x"); }, deps),
      (error: unknown) => error instanceof FastApiCrmError && error.status === 401,
    );
    assert.equal(issued.length, 2);
  });
});
