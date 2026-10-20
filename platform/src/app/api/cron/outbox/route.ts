import { drainOutbox, outboxStats } from "../../../../core/outbox.ts";
import { sendTelegram, telegramConfigFromEnv } from "../../../../core/telegram.ts";
import { bearerOk, json, notifyLevel } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retry worker: called on a schedule with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  if (!bearerOk(request, process.env.CRON_SECRET)) return json({ ok: false, error: "unauthorized" }, 401);
  const config = telegramConfigFromEnv();
  const drained = await drainOutbox(getPool(), { send: (t) => sendTelegram(config, t, 5000), level: notifyLevel(), limit: 20 });
  return json({ ok: true, ...drained, stats: await outboxStats(getPool()) });
}
