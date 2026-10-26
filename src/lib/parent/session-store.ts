/**
 * Where the parent sessions live. The site keeps NO session state of its own: it asks the platform (the process that owns
 * the database) through a bearer-protected internal API. This module has no "server-only" import so that the contract can
 * be tested under node; the server wiring is in ./server.ts.
 *
 * Failure policy: any error (network, timeout, 5xx, malformed answer) is SessionStoreUnavailable. Callers fail closed:
 * no session is assumed valid and none is created silently.
 */
import { ExpiringStore, SessionStoreUnavailable, type SessionRecord, type SessionStore, type TokenUpdate } from "./core.ts";

export { SessionStoreUnavailable, type SessionRecord, type SessionStore, type TokenUpdate };

/** Dev and tests only. Process memory: never wired to a deployment (see server.ts). */
export class MemorySessionStore implements SessionStore {
  private readonly items: ExpiringStore<SessionRecord>;

  constructor(now?: () => number) {
    this.items = new ExpiringStore<SessionRecord>({ ttlMs: 12 * 3600 * 1000, maxEntries: 10_000, now });
  }

  async create(sid: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    this.items.set(sid, record, ttlSeconds * 1000);
  }

  async lookup(sid: string): Promise<SessionRecord | null> {
    return this.items.get(sid) ?? null;
  }

  async rotate(sid: string, update: TokenUpdate): Promise<boolean> {
    const current = this.items.get(sid);
    if (!current) return false;
    this.items.set(sid, { ...current, access: update.access, refresh: update.refresh, accessExpiresAt: update.accessExpiresAt });
    return true;
  }

  async revoke(sid: string): Promise<void> {
    this.items.delete(sid);
  }
}

export interface PlatformStoreOptions {
  /** Origin of the platform API process, e.g. http://127.0.0.1:3100 (loopback) or https://api.example.kz. */
  baseUrl: string;
  /** Service bearer token shared with the platform (PARENT_SESSION_SERVICE_TOKEN). Server env only. */
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SID_RE = /^[A-Za-z0-9_-]{32,128}$/;

function parseRecord(v: unknown): SessionRecord {
  const bad = (): never => {
    throw new SessionStoreUnavailable();
  };
  if (typeof v !== "object" || v === null) return bad();
  const s = (v as { session?: unknown }).session;
  if (typeof s !== "object" || s === null) return bad();
  const r = s as Record<string, unknown>;
  if (typeof r.userId !== "string" || typeof r.csrf !== "string" || typeof r.access !== "string" || typeof r.refresh !== "string") return bad();
  if (typeof r.accessExpiresAt !== "number" || !Number.isFinite(r.accessExpiresAt)) return bad();
  return { userId: r.userId, csrf: r.csrf, access: r.access, refresh: r.refresh, accessExpiresAt: r.accessExpiresAt };
}

/** The HTTP client of the platform's internal parent-session API. Never logs or returns the token or the body. */
export function platformSessionStore(opts: PlatformStoreOptions): SessionStore {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 3000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call(action: "create" | "lookup" | "rotate" | "revoke", body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/internal/parent-sessions/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new SessionStoreUnavailable(); // the original error may contain the URL
    }
    const data: unknown = await res.json().catch(() => undefined);
    return { status: res.status, data };
  }

  const checkSid = (sid: string) => {
    if (!SID_RE.test(sid)) throw new SessionStoreUnavailable();
  };

  return {
    async create(sid, record, ttlSeconds) {
      checkSid(sid);
      const { status } = await call("create", { sid, userId: record.userId, csrf: record.csrf, access: record.access, refresh: record.refresh, accessExpiresAt: record.accessExpiresAt, ttlSeconds });
      if (status !== 201) throw new SessionStoreUnavailable();
    },
    async lookup(sid) {
      checkSid(sid);
      const { status, data } = await call("lookup", { sid });
      if (status === 404) return null;
      if (status !== 200) throw new SessionStoreUnavailable();
      return parseRecord(data);
    },
    async rotate(sid, update) {
      checkSid(sid);
      const { status } = await call("rotate", { sid, access: update.access, refresh: update.refresh, accessExpiresAt: update.accessExpiresAt });
      if (status === 404) return false;
      if (status !== 200) throw new SessionStoreUnavailable();
      return true;
    },
    async revoke(sid) {
      checkSid(sid);
      const { status } = await call("revoke", { sid });
      if (status !== 200) throw new SessionStoreUnavailable();
    },
  };
}
