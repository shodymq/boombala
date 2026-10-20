import type { Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { buildLeadMessage, TelegramError, type LeadNotification } from "./telegram.ts";

/** Waits between attempts (seconds), then the notification is marked `dead` and shows up in the admin. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 10_800, 21_600, 43_200];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const LEASE_SECONDS = 90;

export interface DrainOptions {
  /** Sends one message (injectable; production passes Telegram). Must throw on failure. */
  send: (text: string) => Promise<void>;
  level: "full" | "minimal";
  limit?: number;
  /** Only this enquiry (the "try right now" call after a new enquiry is saved). */
  onlyRefId?: string;
}

export interface DrainResult {
  sent: number;
  retry: number;
  dead: number;
}

interface Claimed {
  id: string;
  ref_id: string;
  attempts: number;
}

/** Atomically claims due tasks (FOR UPDATE SKIP LOCKED + a lease) so two workers never send the same message. */
async function claim(pool: Pool, limit: number, onlyRefId?: string): Promise<Claimed[]> {
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<Claimed>(
      `SELECT id, ref_id, attempts FROM bb.outbox
        WHERE status IN ('pending', 'sending') AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
          AND ($2::uuid IS NULL OR ref_id = $2::uuid)
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit, onlyRefId ?? null],
    );
    if (rows.length) {
      await tx.query(
        "UPDATE bb.outbox SET status = 'sending', attempts = attempts + 1, locked_until = now() + make_interval(secs => $2) WHERE id = ANY($1::uuid[])",
        [rows.map((r) => r.id), LEASE_SECONDS],
      );
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

async function loadLead(pool: Pool, leadId: string): Promise<LeadNotification | null> {
  const { rows } = await pool.query(
    `SELECT l.seq, c.name, c.phone_e164, to_char(l.requested_date, 'YYYY-MM-DD') AS d, l.children, p.name AS package_name, r.name AS room_name, CASE WHEN l.slot_id IS NULL THEN NULL ELSE (SELECT to_char(t.starts_at, 'HH24:MI') || '–' || to_char(t.ends_at, 'HH24:MI') FROM bb.time_slots t WHERE t.id = l.slot_id) END AS slot_label,
            l.page, l.referrer, l.utm_source, l.utm_medium, l.utm_campaign, l.created_at,
            (SELECT d.version FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
              WHERE e.lead_request_id = l.id AND e.event = 'given' ORDER BY e.id LIMIT 1) AS consent_version
       FROM bb.lead_requests l
       JOIN bb.contacts c ON c.id = l.contact_id
       LEFT JOIN bb.packages p ON p.id = l.package_id
       LEFT JOIN bb.rooms r ON r.id = l.room_id
      WHERE l.id = $1`,
    [leadId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    seq: Number(r.seq), name: r.name, phone: r.phone_e164, date: r.d, children: r.children, packageName: r.package_name, roomName: r.room_name, slotLabel: r.slot_label,
    consentVersion: r.consent_version, page: r.page, referrer: r.referrer, utmSource: r.utm_source, utmMedium: r.utm_medium, utmCampaign: r.utm_campaign, createdAt: r.created_at,
  };
}

/** Error CODES only: never names, phones, tokens or exception messages. */
function errorCode(error: unknown): string {
  if (error instanceof TelegramError) return error.code;
  return "send_failed";
}

export async function drainOutbox(pool: Pool, options: DrainOptions): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retry: 0, dead: 0 };
  const claimed = await claim(pool, options.limit ?? 10, options.onlyRefId);
  for (const task of claimed) {
    try {
      const lead = await loadLead(pool, task.ref_id);
      if (!lead) throw new Error("lead_missing");
      await options.send(buildLeadMessage(lead, options.level));
      await pool.query("UPDATE bb.outbox SET status = 'sent', sent_at = now(), locked_until = NULL, last_error_code = NULL WHERE id = $1", [task.id]);
      result.sent++;
    } catch (error) {
      const code = errorCode(error);
      if (task.attempts >= MAX_ATTEMPTS) {
        await pool.query("UPDATE bb.outbox SET status = 'dead', locked_until = NULL, last_error_code = $2 WHERE id = $1", [task.id, code]);
        result.dead++;
      } else {
        const wait = BACKOFF_SECONDS[Math.min(task.attempts - 1, BACKOFF_SECONDS.length - 1)];
        await pool.query(
          "UPDATE bb.outbox SET status = 'pending', locked_until = NULL, last_error_code = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1",
          [task.id, code, wait],
        );
        result.retry++;
      }
      // One structured line, safe by construction: ids and codes only.
      console.warn(JSON.stringify({ event: "outbox.send_failed", outboxId: task.id, attempt: task.attempts, code }));
    }
  }
  return result;
}

export interface OutboxStats {
  pending: number;
  dead: number;
  oldestPendingSeconds: number | null;
}

export async function outboxStats(pool: Pool): Promise<OutboxStats> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status IN ('pending','sending'))::int AS pending, count(*) FILTER (WHERE status = 'dead')::int AS dead,
            floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('pending','sending'))))::int AS oldest
       FROM bb.outbox`,
  );
  return { pending: rows[0].pending, dead: rows[0].dead, oldestPendingSeconds: rows[0].oldest };
}
