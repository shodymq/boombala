import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BOOKING_SHEETS_ID } from "../core/sheets-import/production-block-import.ts";
import type { RawRow, SheetRead } from "../core/sheets-import/types.ts";
import type { Pool } from "../core/db.ts";
import { withTx } from "../core/db.ts";
import { runSheetsLiveSync, type SheetSyncResult } from "./sheets-live-sync.ts";
import { getPool } from "./db.ts";

export const SHEETS_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const MAX_AGE_SECONDS = 300;
const LEASE_SECONDS = 10 * 60;
const ROW_FIELDS = new Set(["sourceId", "date", "time", "package", "animator", "room", "client", "phone", "child", "age", "prepayment", "children", "adults", "comment"]);

const rawRowSchema = z.record(z.string(), z.string().max(1000)).superRefine((row, ctx) => {
  if (Object.keys(row).some((key) => !ROW_FIELDS.has(key))) ctx.addIssue({ code: "custom", message: "invalid_field" });
});
const payloadSchema = z.object({
  requestId: z.string().uuid(),
  spreadsheetId: z.literal(BOOKING_SHEETS_ID),
  sheetId: z.number().int().nonnegative(),
  sheetTitle: z.literal("Лист1"),
  spreadsheetTimeZone: z.string().min(1).max(80),
  mode: z.enum(["dry_run", "apply"]),
  blankRows: z.number().int().min(0).max(50_000),
  rows: z.array(z.object({
    rowNumber: z.number().int().min(3).max(50_000),
    raw: rawRowSchema,
  }).strict()).max(600),
}).strict();
type WebhookPayload = z.infer<typeof payloadSchema>;

export type SheetsWebhookResponse =
  | { ok: true; replay: boolean; result: SheetSyncResult }
  | { ok: false; error: "disabled" | "unauthorized" | "invalid_payload" | "replay" | "idempotency_conflict" | "request_in_progress" | "sync_busy" | "sync_failed" };

export class SheetsWebhookError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 413 | 503;
  readonly code: string;

  constructor(status: 400 | 401 | 404 | 409 | 413 | 503, code: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = "SheetsWebhookError";
  }
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function signature(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`, "utf8").digest("hex");
}

function asSheet(payload: WebhookPayload): SheetRead {
  return {
    spreadsheetId: payload.spreadsheetId,
    sheetId: payload.sheetId,
    sheetTitle: payload.sheetTitle,
    spreadsheetTimeZone: payload.spreadsheetTimeZone,
    blankRows: payload.blankRows,
    rows: payload.rows.map(({ rowNumber, raw }) => ({
      raw: raw as RawRow,
      source: { spreadsheetId: payload.spreadsheetId, sheetId: payload.sheetId, rowNumber },
    })),
  };
}

function summary(result: SheetSyncResult): SheetSyncResult {
  return { runId: result.runId, mode: result.mode, counts: result.counts, lastUpdated: result.lastUpdated };
}

/** Authenticate a bounded raw request before parsing or touching source data. Persistent rows contain hashes and summaries only. */
export async function processSignedSheetsWebhook(input: {
  timestamp: string | null; nonce: string | null; signature: string | null; rawBody: string;
  pool?: Pool; now?: Date;
}): Promise<SheetsWebhookResponse> {
  // This ingress writes through the VPS database-backed booking writer. Never expose it from Vercel,
  // even if someone accidentally copies the enable flags there.
  if (process.env.VERCEL === "1" || process.env.SHEETS_WEBHOOK_ENABLED !== "1") throw new SheetsWebhookError(404, "disabled");
  if (Buffer.byteLength(input.rawBody, "utf8") > SHEETS_WEBHOOK_MAX_BODY_BYTES) throw new SheetsWebhookError(413, "invalid_payload");
  const secret = process.env.SHEETS_WEBHOOK_HMAC_KEY ?? "";
  const timestamp = input.timestamp ?? "";
  const nonce = input.nonce ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32 || !/^\d{10}$/.test(timestamp) || !z.string().uuid().safeParse(nonce).success || !input.signature) {
    throw new SheetsWebhookError(401, "unauthorized");
  }
  const seconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(seconds - Number(timestamp)) > MAX_AGE_SECONDS || !constantTimeHexEquals(input.signature, signature(secret, timestamp, nonce, input.rawBody))) {
    throw new SheetsWebhookError(401, "unauthorized");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input.rawBody); } catch { throw new SheetsWebhookError(400, "invalid_payload"); }
  const validated = payloadSchema.safeParse(parsed);
  if (!validated.success) throw new SheetsWebhookError(400, "invalid_payload");
  const payload = validated.data;
  if (payload.mode === "apply" && process.env.SHEETS_SYNC_ENABLED !== "1") throw new SheetsWebhookError(404, "disabled");

  const pool = input.pool ?? getPool();
  const bodyHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  const leaseId = randomUUID();
  const claim = await withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`sheets-webhook:${payload.requestId}`]);
    const existing = await tx.query<{ body_hash: string; status: string; lease_until: Date | null; result: SheetSyncResult | null }>(
      "SELECT body_hash,status,lease_until,result FROM bb.sheet_sync_webhook_requests WHERE request_id=$1 FOR UPDATE", [payload.requestId]);
    const previous = existing.rows[0];
    if (previous && previous.body_hash !== bodyHash) throw new SheetsWebhookError(409, "idempotency_conflict");
    if (previous?.status === "completed" && previous.result) return { kind: "cached" as const, result: previous.result };
    if (previous?.status === "processing" && previous.lease_until && previous.lease_until > (input.now ?? new Date())) {
      throw new SheetsWebhookError(409, "request_in_progress");
    }
    await tx.query("DELETE FROM bb.sheet_sync_webhook_nonces WHERE received_at < now() - interval '1 day'");
    await tx.query(
      `INSERT INTO bb.sheet_sync_webhook_requests (request_id,body_hash,status,lease_id,lease_until,updated_at)
       VALUES ($1,$2,'processing',$3,now()+($4::int * interval '1 second'),now())
       ON CONFLICT (request_id) DO UPDATE SET status='processing',lease_id=EXCLUDED.lease_id,
         lease_until=EXCLUDED.lease_until,result=NULL,safe_error_code=NULL,updated_at=now()`,
      [payload.requestId, bodyHash, leaseId, LEASE_SECONDS],
    );
    try {
      await tx.query("INSERT INTO bb.sheet_sync_webhook_nonces (nonce,request_id) VALUES ($1,$2)", [nonce, payload.requestId]);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new SheetsWebhookError(409, "replay");
      throw error;
    }
    return { kind: "claimed" as const };
  });
  if (claim.kind === "cached") return { ok: true, replay: true, result: claim.result };

  try {
    const result = await runSheetsLiveSync({
      mode: payload.mode,
      trigger: "webhook",
      pool,
      readSource: async () => asSheet(payload),
    });
    if (result.runId === null) throw new SheetsWebhookError(409, "sync_busy");
    const safeResult = summary(result);
    await pool.query(
      `UPDATE bb.sheet_sync_webhook_requests SET status='completed',sync_run_id=$2,result=$3::jsonb,
         lease_id=NULL,lease_until=NULL,safe_error_code=NULL,updated_at=now()
       WHERE request_id=$1 AND lease_id=$4`,
      [payload.requestId, result.runId, JSON.stringify(safeResult), leaseId],
    );
    return { ok: true, replay: false, result: safeResult };
  } catch (error) {
    const code = error instanceof SheetsWebhookError ? error.code : error instanceof Error && /^[a-z0-9_]{1,60}$/.test(error.message) ? error.message : "sync_failed";
    await pool.query(
      `UPDATE bb.sheet_sync_webhook_requests SET status='failed',lease_id=NULL,lease_until=NULL,safe_error_code=$3,updated_at=now()
       WHERE request_id=$1 AND lease_id=$2`, [payload.requestId, leaseId, code],
    ).catch(() => undefined);
    if (error instanceof SheetsWebhookError) throw error;
    throw new SheetsWebhookError(503, "sync_failed");
  }
}

/** Server route helper with bounded streaming reads; chunked bodies cannot bypass the limit. */
export async function readBoundedRequestBody(request: Request): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new SheetsWebhookError(400, "invalid_payload");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SHEETS_WEBHOOK_MAX_BODY_BYTES) throw new SheetsWebhookError(413, "invalid_payload");
  if (!request.body) throw new SheetsWebhookError(400, "invalid_payload");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > SHEETS_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new SheetsWebhookError(413, "invalid_payload");
    }
    chunks.push(next.value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new SheetsWebhookError(400, "invalid_payload");
  }
}
