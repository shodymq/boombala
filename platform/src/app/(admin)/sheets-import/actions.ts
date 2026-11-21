"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { importBookingSheetBlocks, parseBookingSheetsText, SheetBlockImportError } from "@/core/sheets-import/production-block-import";
import { FastApiCrmError, legacyCrmBridgeEnabled, unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";
import { withFastApiClient } from "@/server/crm-actor";
import { requirePermission } from "@/server/dal";
import { runSheetsLiveSync } from "@/server/sheets-live-sync";

function fail(code: string): never {
  const safe = /^[a-z0-9_]{1,60}$/.test(code) ? code : "import_failed";
  redirect(`/sheets-import?error=${encodeURIComponent(safe)}`);
}

/** Owner-only migration UI; every write uses the existing typed booking.block operation. */
export async function runBookingSheetsBlockImport(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  if (session.user.role !== "owner") redirect("/bookings?error=forbidden");
  if (!legacyCrmBridgeEnabled() || !unifiedFastapiCrmEnabled()) fail("production_bridge_unavailable");

  const raw = formData.get("plan");
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 100_000) fail("invalid_plan");
  let json: unknown;
  try {
    json = raw;
  } catch {
    fail("invalid_plan");
  }

  let result: Awaited<ReturnType<typeof importBookingSheetBlocks>>;
  try {
    const plan = parseBookingSheetsText(json as string);
    result = await withFastApiClient(session, (client) => importBookingSheetBlocks(plan, client));
  } catch (error) {
    if (error instanceof SheetBlockImportError) fail(error.code);
    if (error instanceof FastApiCrmError) fail(error.code);
    fail("import_failed");
  }

  revalidatePath("/bookings");
  const params = new URLSearchParams({ run: "1" });
  for (const [key, value] of Object.entries(result.counts)) params.set(key, String(value));
  redirect(`/sheets-import?${params.toString()}`);
}

/** Owner-only manual trigger for the server-side, read-only Sheets reader and the shared production booking writer. */
export async function runSheetsSyncNow(): Promise<void> {
  const session = await requirePermission("bookings.manage");
  if (session.user.role !== "owner") redirect("/bookings?error=forbidden");
  try {
    await runSheetsLiveSync({ mode: "auto", trigger: "manual" });
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,60}$/.test(error.message) ? error.message : "sync_failed";
    fail(code);
  }
  revalidatePath("/sheets-import");
  redirect("/sheets-import?sync=1");
}
