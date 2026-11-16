import { readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../src/core/db.ts";
import { almatyToday } from "../src/core/dates.ts";
import { parseWorkingHours } from "../src/core/booking-calendar.ts";
import { googleSheetsClient, readSheet, type SheetRead } from "../src/core/sheets-import/reader.ts";
import { readCsv } from "../src/core/sheets-import/csv.ts";
import { normalizeRow } from "../src/core/sheets-import/normalize.ts";
import { reconcile, summarize } from "../src/core/sheets-import/reconcile.ts";
import { ensureStaging, loadCatalog, loadCrmSnapshot, stageRows } from "../src/core/sheets-import/importer.ts";

// Dry run only. Input: Sheets API (GOOGLE_SERVICE_ACCOUNT_KEY_FILE) or a local CSV export (--csv file).
// READ_URL: read-only access to the database to compare with (SELECT only, wrapped in a READ ONLY transaction).
// STAGING_URL: a scratch database for sheet_import.rows; it must differ from READ_URL.
// stdout: aggregate counts only (no names, phones, amounts). Row-level data only in --report-file (local, mode 600).
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const spreadsheetId = arg("spreadsheet") ?? process.env.SHEETS_SPREADSHEET_ID;
const csvPath = arg("csv");
const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const readUrl = process.env.READ_URL, stagingUrl = process.env.STAGING_URL;
if (!spreadsheetId || !readUrl || (!csvPath && !keyPath)) { console.error("need --spreadsheet/SHEETS_SPREADSHEET_ID, READ_URL and either --csv <file> or GOOGLE_SERVICE_ACCOUNT_KEY_FILE"); process.exit(2); }
if (stagingUrl && stagingUrl === readUrl) { console.error("STAGING_URL must differ from READ_URL"); process.exit(2); }
const hours = arg("hours") ? parseWorkingHours(arg("hours")) : null;
if (arg("hours") && !hours) { console.error("--hours must look like 10:00-23:00 and span at least four hours"); process.exit(2); }

const readPool = createPool(readUrl, { max: 1 });
try {
  const sheet: SheetRead = csvPath
    ? readCsv(readFileSync(csvPath, "utf8"), { spreadsheetId, sheetId: Number(arg("sheet-id") ?? 0) })
    : await readSheet(googleSheetsClient(JSON.parse(readFileSync(keyPath!, "utf8"))), spreadsheetId, { sheetTitle: arg("sheet") });
  const ro = await readPool.connect();
  let catalog, crm;
  try {
    await ro.query("BEGIN TRANSACTION READ ONLY");
    catalog = await loadCatalog(ro);
    crm = await loadCrmSnapshot(ro);
  } finally { await ro.query("ROLLBACK").catch(() => {}); ro.release(); }
  const today = almatyToday();
  const rows = reconcile(sheet.rows.map((r) => normalizeRow(r.raw, r.source, catalog)), crm, today, hours ? { workingHours: hours } : {});
  const out: Record<string, unknown> = { input: csvPath ? "csv" : "api", spreadsheetTimeZone: sheet.spreadsheetTimeZone, workingHoursChecked: Boolean(hours), blankRowsIgnored: sheet.blankRows, ...summarize(rows, today) };
  if (stagingUrl) {
    const staging = createPool(stagingUrl, { max: 1 });
    try { await ensureStaging(staging); out.staging = await stageRows(staging, spreadsheetId, rows); } finally { await staging.end(); }
  }
  const reportFile = arg("report-file");
  if (reportFile) writeFileSync(reportFile, JSON.stringify(rows, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`dry run failed: ${(e as Error).message.split("\n")[0].slice(0, 120)}`); // never echo row data
  process.exitCode = 1;
} finally { await readPool.end(); }
