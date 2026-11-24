import "server-only";

import type { Pool } from "../core/db.ts";
import { getPool } from "./db.ts";

export type SheetSyncStatus = {
  lastUpdated: string | null;
  counts: Record<string, number> | null;
  reviewItems: Array<{ rowNumber: number; sourceKey: string | null; status: string; safeCode: string | null; reservationId: string | null }>;
  outcome: string | null;
  safeErrorCode: string | null;
  enabled: boolean;
  manualReview: number;
  sourceMissing: number;
};

/** Aggregate-only sync status. The Vercel UI reads this through the authenticated VPS bridge. */
export async function getLatestSheetSyncStatus(pool: Pool = getPool()): Promise<SheetSyncStatus> {
  try {
    const [run, records] = await Promise.all([
      pool.query<{ finished_at: Date | null; outcome: string; counts: Record<string, number>; review_items: SheetSyncStatus["reviewItems"]; safe_error_code: string | null }>(
        "SELECT finished_at,outcome,counts,review_items,safe_error_code FROM bb.sheet_sync_runs ORDER BY id DESC LIMIT 1",
      ),
      pool.query<{ manual_review: number; source_missing: number }>(
        "SELECT count(*) FILTER (WHERE state='manual_review')::int manual_review,count(*) FILTER (WHERE state='source_missing')::int source_missing FROM bb.sheet_sync_records",
      ),
    ]);
    return {
      lastUpdated: run.rows[0]?.finished_at?.toISOString() ?? null,
      counts: run.rows[0]?.counts ?? null,
      reviewItems: run.rows[0]?.review_items ?? [],
      outcome: run.rows[0]?.outcome ?? null,
      safeErrorCode: run.rows[0]?.safe_error_code ?? null,
      enabled: process.env.SHEETS_SYNC_ENABLED === "1",
      manualReview: records.rows[0]?.manual_review ?? 0,
      sourceMissing: records.rows[0]?.source_missing ?? 0,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      return { lastUpdated: null, counts: null, reviewItems: [], outcome: "migration_required", safeErrorCode: "migration_required", enabled: false, manualReview: 0, sourceMissing: 0 };
    }
    throw error;
  }
}
