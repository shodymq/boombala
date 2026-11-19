import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

/**
 * Per-request timing for the bridge. It records only counts and durations (never SQL text, parameters or rows), so it is safe
 * to expose to the authenticated frontend as a `Server-Timing` header and to log with `CRM_PERF_LOG=1`.
 */
export interface PerfStore {
  /** Number of SQL statements and the sum of their durations (parallel statements add up, so this can exceed wall time). */
  queries: number;
  dbMs: number;
}

// One store per process even when the bundler emits this module into several chunks (a duplicated module would hide the
// request context from the database wrapper and the counters would stay at zero).
const KEY = Symbol.for("bb.perf.storage");
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<PerfStore> | undefined>;
const storage = (holder[KEY] ??= new AsyncLocalStorage<PerfStore>());

export function runWithPerf<T>(fn: () => Promise<T>): Promise<{ result: T; perf: PerfStore }> {
  const perf: PerfStore = { queries: 0, dbMs: 0 };
  return storage.run(perf, async () => ({ result: await fn(), perf }));
}

const WRAPPED = Symbol.for("bb.perf.wrapped");

/** Wraps `client.query` once so every statement of the current request is counted. Zero cost outside a measured request. */
export function instrumentClient(client: pg.PoolClient): void {
  const marked = client as unknown as Record<symbol, boolean>;
  if (marked[WRAPPED]) return;
  marked[WRAPPED] = true;
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const store = storage.getStore();
    if (!store) return original(...args);
    const started = performance.now();
    let counted = false;
    const done = () => {
      if (counted) return;
      counted = true;
      store.queries += 1;
      store.dbMs += performance.now() - started;
    };
    // pg's Pool.query talks to the client in callback style; direct calls return a promise. Count both.
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (...cb: unknown[]) => {
        done();
        return (last as (...a: unknown[]) => unknown)(...cb);
      };
      return original(...args);
    }
    const out = original(...args);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(done, done);
    }
    return out;
  };
}
