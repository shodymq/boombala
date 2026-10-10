/**
 * In-memory helpers for POST /api/lead. Best-effort only: on serverless every instance has its own
 * memory, so these stop casual spam and double taps, not a determined attacker. Add an edge/WAF limit
 * (e.g. Vercel Firewall) for anything stronger.
 *
 * Design rule: nothing here may cost a real parent their lead. Invalid or undeliverable submissions
 * are never counted, and a lead is only remembered as "done" after it was actually delivered.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

/** Is `key` still under `limit` in the current window? Does not count anything. */
export function rateLimitCheck(key: string, limit = 30): { ok: boolean; retryAfter: number } {
  const entry = hits.get(key);
  const now = Date.now();
  if (!entry || entry.resetAt <= now || entry.count < limit) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
}

/** Count one DELIVERED lead for `key` (fixed window). */
export function rateLimitRecord(key: string, windowMs = 10 * 60 * 1000): void {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
  else entry.count += 1;
}

const jobs = new Map<string, { promise: Promise<void>; doneUntil: number }>();

/**
 * Runs `send` once per `key`:
 *  - while it is in flight, an identical request waits for it and shares its outcome (double tap);
 *  - after it SUCCEEDED, an identical request within `ttlMs` is reported as a duplicate and not re-sent;
 *  - if it FAILED, the key is forgotten at once so the parent's retry really tries again.
 */
export async function deliverOnce(
  key: string,
  send: () => Promise<void>,
  ttlMs = 90_000,
): Promise<{ duplicate: boolean }> {
  const now = Date.now();
  if (jobs.size > 2000) for (const [k, j] of jobs) if (j.doneUntil <= now) jobs.delete(k);
  const existing = jobs.get(key);
  if (existing && existing.doneUntil > now) {
    await existing.promise; // rejects with the same error if the first attempt fails
    return { duplicate: true };
  }
  const entry = { promise: send(), doneUntil: Number.POSITIVE_INFINITY };
  jobs.set(key, entry);
  try {
    await entry.promise;
    entry.doneUntil = Date.now() + ttlMs;
    return { duplicate: false };
  } catch (error) {
    if (jobs.get(key) === entry) jobs.delete(key);
    throw error;
  }
}
