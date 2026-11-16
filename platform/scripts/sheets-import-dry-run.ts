import { readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../src/core/db.ts";
import { almatyToday } from "../src/core/dates.ts";
import { googleSheetsClient, readSheet, type SheetsClient } from "../src/core/sheets-import/reader.ts";
import { normalizeRow } from "../src/core/sheets-import/normalize.ts";
import { reconcile, summarize } from "../src/core/sheets-import/reconcile.ts";
import { ensureStaging, loadCatalog, loadCrmSnapshot, stageRows } from "../src/core/sheets-import/importer.ts";

// Dry run only. READ_URL: read-only access to the database to compare with (production allowed: SELECT only, no writes).
// STAGING_URL: a scratch/staging database for sheet_import.rows. It must be a different, non-production database.
// Prints aggregate counts only (no names, phones or amounts). Row-level output goes to --report-file (local, gitignored).
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const spreadsheetId = arg("spreadsheet") ?? process.env.SHEETS_SPREADSHEET_ID;
const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const readUrl = process.env.READ_URL, stagingUrl = process.env.STAGING_URL;
if (!spreadsheetId || !keyPath || !readUrl) { console.error("need SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_KEY_FILE, READ_URL"); process.exit(2); }
if (stagingUrl && stagingUrl === readUrl) { console.error("STAGING_URL must differ from READ_URL"); process.exit(2); }

const client: SheetsClient = googleSheetsClient(JSON.parse(readFileSync(keyPath, "utf8")));
const readPool = createPool(readUrl, { max: 1 });
try {
  const sheet = await readSheet(client, spreadsheetId, { sheetTitle: arg("sheet") });
  const ro = await readPool.connect();
  let catalog, crm;
  try {
    await ro.query("BEGIN TRANSACTION READ ONLY");
    catalog = await loadCatalog(ro);
    crm = await loadCrmSnapshot(ro);
  } finally { await ro.query("ROLLBACK").catch(() => {}); ro.release(); }
  const today = almatyToday();
  const rows = reconcile(sheet.rows.map((r) => normalizeRow(r.raw, r.source, catalog)), crm, today);
  const out: Record<string, unknown> = { spreadsheetTimeZone: sheet.spreadsheetTimeZone, blankRowsIgnored: sheet.blankRows, ...summarize(rows, today) };
  if (stagingUrl) {
    const staging = createPool(stagingUrl, { max: 1 });
    try { await ensureStaging(staging); out.staging = await stageRows(staging, spreadsheetId, rows); } finally { await staging.end(); }
  }
  const reportFile = arg("report-file");
  if (reportFile) writeFileSync(reportFile, JSON.stringify(rows, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
} finally { await readPool.end(); }
