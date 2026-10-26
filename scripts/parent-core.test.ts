/**
 * Tests for src/lib/parent/core.ts: feature gates, phone and origin checks, CSRF, bounded store,
 * token refresh on behalf of the parent, and the cabinet view model. No network.
 *
 *   npm run test:parent
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCabinet,
  callAsParent,
  describeStatus,
  ExpiringStore,
  guardPost,
  isSameOrigin,
  normalizeKzMobile,
  parentLoginState,
  ParentSessionEnded,
  randomToken,
  sameSecret,
  type ParentSession,
} from "../src/lib/parent/core.ts";
import { FastapiError, createFastapiClient, type ParentChild, type ParentRequest } from "../src/lib/fastapi/core.ts";

const ON = {
  PARENT_LOGIN: "on",
  FASTAPI_FEATURES: "otp,account",
  FASTAPI_BASE_URL: "https://api-staging.example.kz/api/v1",
};

// ── Feature gate ────────────────────────────────────────────────────────────────────────────────

test("parent login is OFF unless PARENT_LOGIN=on", () => {
  assert.deepEqual(parentLoginState({ ...ON, PARENT_LOGIN: undefined }), { enabled: false, reason: "flag_off" });
  assert.deepEqual(parentLoginState({ ...ON, PARENT_LOGIN: "true" }), { enabled: false, reason: "flag_off" });
});

test("rollback-safe profile never enables parent login", () => {
  assert.deepEqual(parentLoginState({ ...ON, SITE_PROFILE: "rollback-safe" }), { enabled: false, reason: "rollback_profile" });
});

test("needs both FastAPI features otp and account", () => {
  assert.deepEqual(parentLoginState({ ...ON, FASTAPI_FEATURES: "otp" }), { enabled: false, reason: "feature_off" });
  assert.deepEqual(parentLoginState({ ...ON, FASTAPI_FEATURES: "account" }), { enabled: false, reason: "feature_off" });
});

test("unsafe FastAPI URL turns parent login off instead of sending data", () => {
  assert.deepEqual(parentLoginState({ ...ON, FASTAPI_BASE_URL: "http://api.example.kz" }), {
    enabled: false,
    reason: "fastapi_not_configured",
  });
});

test("production is closed even when everything else is set", () => {
  const prod = { ...ON, NODE_ENV: "production" };
  assert.deepEqual(parentLoginState(prod), { enabled: false, reason: "production_not_approved" });
  assert.deepEqual(parentLoginState({ ...prod, PARENT_LOGIN_PRODUCTION_APPROVED: "1" }), {
    enabled: false,
    reason: "shared_session_store_not_implemented",
  });
});

test("with the flag on in development, login is enabled", () => {
  assert.deepEqual(parentLoginState(ON), { enabled: true });
});

// ── Phone ───────────────────────────────────────────────────────────────────────────────────────

test("Kazakhstan mobile numbers normalise to +77…", () => {
  assert.equal(normalizeKzMobile("+7 707 123 45 67"), "+77071234567");
  assert.equal(normalizeKzMobile("8 (707) 123-45-67"), "+77071234567");
  assert.equal(normalizeKzMobile("77071234567"), "+77071234567");
});

test("non-mobile and malformed numbers are refused", () => {
  assert.equal(normalizeKzMobile("+7 727 123 45 67"), null); // not a mobile prefix
  assert.equal(normalizeKzMobile("+7707123"), null);
  assert.equal(normalizeKzMobile("abc"), null);
  assert.equal(normalizeKzMobile("+77071234567 OR 1=1"), null);
});

// ── Origin and CSRF ─────────────────────────────────────────────────────────────────────────────

test("origin must match the host; missing origin is refused", () => {
  assert.equal(isSameOrigin("https://boombala.kz", "boombala.kz"), true);
  assert.equal(isSameOrigin("https://evil.example", "boombala.kz"), false);
  assert.equal(isSameOrigin(null, "boombala.kz"), false);
  assert.equal(isSameOrigin("not a url", "boombala.kz"), false);
});

test("CSRF comparison needs equal, non-empty values", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret("abc", null), false);
});

test("guardPost refuses cross-site, non-JSON and missing-CSRF posts", () => {
  const base = { origin: "https://boombala.kz", host: "boombala.kz", contentType: "application/json" };
  assert.equal(guardPost(base), null);
  assert.equal(guardPost({ ...base, origin: "https://evil.example" }), "forbidden_origin");
  assert.equal(guardPost({ ...base, contentType: "text/plain" }), "unsupported_media_type");
  assert.equal(guardPost({ ...base, expectedCsrf: "tok-123456", csrfHeader: null }), "forbidden_csrf");
  assert.equal(guardPost({ ...base, expectedCsrf: "tok-123456", csrfHeader: "wrong" }), "forbidden_csrf");
  assert.equal(guardPost({ ...base, expectedCsrf: "tok-123456", csrfHeader: "tok-123456" }), null);
});

test("random tokens are url-safe and use the injected source", () => {
  const t = randomToken(32, (buf) => buf.fill(255));
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(!t.includes("="));
  assert.notEqual(randomToken(32), randomToken(32));
});

// ── Bounded store ───────────────────────────────────────────────────────────────────────────────

test("store expires entries and never grows past its bound", () => {
  let t = 0;
  const store = new ExpiringStore<string>({ ttlMs: 1000, maxEntries: 2, now: () => t });
  store.set("a", "1");
  store.set("b", "2");
  store.set("c", "3"); // evicts the oldest
  assert.equal(store.size, 2);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("c"), "3");
  t = 2000;
  assert.equal(store.get("c"), undefined);
  assert.equal(store.size, 0);
});

// ── Calls on behalf of the parent: refresh rules ───────────────────────────────────────────────

function session(over: Partial<ParentSession> = {}): ParentSession {
  return {
    csrfToken: "csrf-token-123",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accessExpiresAt: 10 * 60_000,
    userId: "u-1",
    ...over,
  };
}

function setup(now: number, rejectsRefresh = false) {
  const sessions = new ExpiringStore<ParentSession>({ ttlMs: 60_000, maxEntries: 10, now: () => now });
  sessions.set("sid", session());
  const refreshCalls: string[] = [];
  const deps = {
    client: createFastapiClient({ config: null }),
    sessions,
    now: () => now,
    refresh: async (_client: unknown, refreshToken: string) => {
      refreshCalls.push(refreshToken);
      if (rejectsRefresh) throw new FastapiError("rejected", 401, "invalid_token");
      return { access_token: "access-new", refresh_token: "refresh-new", expires_in_seconds: 900 };
    },
  };
  return { deps, sessions, refreshCalls };
}

test("a fresh access token is used without refreshing", async () => {
  const { deps, refreshCalls } = setup(0);
  const seen: string[] = [];
  await callAsParent(deps, "sid", async (token) => {
    seen.push(token);
    return 1;
  });
  assert.deepEqual(seen, ["access-old"]);
  assert.equal(refreshCalls.length, 0);
});

test("a token at its margin-adjusted deadline is refreshed first and the rotated refresh token is stored", async () => {
  // accessExpiresAt already has the safety margin removed, so reaching it means "refresh now".
  const { deps, sessions, refreshCalls } = setup(10 * 60_000);
  await callAsParent(deps, "sid", async (token) => token);
  assert.deepEqual(refreshCalls, ["refresh-old"]);
  const stored = sessions.get("sid");
  assert.equal(stored?.refreshToken, "refresh-new");
  assert.equal(stored?.accessToken, "access-new");
});

test("401 from FastAPI triggers one refresh and one retry", async () => {
  const { deps, refreshCalls } = setup(0);
  let attempts = 0;
  const out = await callAsParent(deps, "sid", async (token) => {
    attempts += 1;
    if (token === "access-old") throw new FastapiError("rejected", 401, "expired");
    return `ok:${token}`;
  });
  assert.equal(out, "ok:access-new");
  assert.equal(attempts, 2);
  assert.equal(refreshCalls.length, 1);
});

test("a rejected refresh token ends the session", async () => {
  const { deps, sessions } = setup(0, true);
  await assert.rejects(
    callAsParent(deps, "sid", async () => {
      throw new FastapiError("rejected", 401, "expired");
    }),
    ParentSessionEnded,
  );
  assert.equal(sessions.get("sid"), undefined);
});

test("FastAPI outage keeps the session and reports the failure", async () => {
  const { deps, sessions } = setup(0);
  await assert.rejects(
    callAsParent(deps, "sid", async () => {
      throw new FastapiError("unavailable", 503);
    }),
    (e: unknown) => e instanceof FastapiError && e.kind === "unavailable",
  );
  assert.ok(sessions.get("sid"), "session must survive an outage");
});

test("unknown session is reported as ended without any call", async () => {
  const { deps, refreshCalls } = setup(0);
  await assert.rejects(callAsParent(deps, "missing", async () => 1), ParentSessionEnded);
  assert.equal(refreshCalls.length, 0);
});

// ── Cabinet view model ──────────────────────────────────────────────────────────────────────────

const PROFILE = {
  id: "u-1",
  phone: "+77071234567",
  email: null,
  firstName: "Айгуль",
  lastName: null,
  onboardingCompleted: true,
};

const CHILD: ParentChild = { id: "c-1", name: "Алина", birthDate: "2019-05-01", gender: "female" };

function req(over: Partial<ParentRequest>): ParentRequest {
  return {
    id: "r-x",
    type: "birthday_request",
    status: "new",
    createdAt: "2026-10-01T10:00:00Z",
    requestedDate: "2026-11-15",
    guestCount: 12,
    branchName: "Главный",
    packageName: "MAGIC PARTY",
    childName: "Алина",
    ...over,
  };
}

test("cabinet keeps only birthday requests, newest first, with grouped statuses", () => {
  const cabinet = buildCabinet(PROFILE, [CHILD], [
    req({ id: "old", createdAt: "2026-09-01T10:00:00Z", status: "completed" }),
    req({ id: "new", createdAt: "2026-10-20T10:00:00Z", status: "contacted" }),
    req({ id: "contact", type: "contact" }),
  ]);
  assert.deepEqual(
    cabinet.requests.map((r) => [r.id, r.group]),
    [
      ["new", "waiting"],
      ["old", "finished"],
    ],
  );
  assert.equal(cabinet.children.length, 1);
});

test("internal notes never reach the cabinet model", () => {
  const raw = { ...req({}), notes: "внутренняя заметка менеджера" } as ParentRequest;
  const cabinet = buildCabinet(PROFILE, [], [raw]);
  assert.ok(!JSON.stringify(cabinet).includes("внутренняя"));
});

test("unknown statuses are shown as in progress, never as confirmed", () => {
  assert.deepEqual(describeStatus("some_future_status"), { label: "В обработке", group: "waiting" });
  assert.equal(describeStatus("booked").group, "confirmed");
  assert.equal(describeStatus("lost").group, "cancelled");
});
