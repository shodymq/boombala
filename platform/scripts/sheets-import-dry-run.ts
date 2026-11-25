import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../src/core/db.ts";
import { almatyToday } from "../src/core/dates.ts";
import { parseWorkingHours } from "../src/core/booking-calendar.ts";
import { readCsv } from "../src/core/sheets-import/csv.ts";
import { normalizeRow } from "../src/core/sheets-import/normalize.ts";
import { reconcile, summarize } from "../src/core/sheets-import/reconcile.ts";
import { checkReadAccess, ensureStaging, loadCatalog, loadCrmSnapshot, stageRows } from "../src/core/sheets-import/importer.ts";

// Dry run only. Input is a local CSV export (--csv file); live reads are performed by the private owner Apps Script.
// READ_URL: read-only access to the database to compare with (SELECT only, wrapped in a READ ONLY transaction).
// STAGING_URL: a scratch database for sheet_import.rows; it must differ from READ_URL.
// --allow-empty-crm yes: only for a genuinely empty scratch database.
// --allow-privileged-read-url yes: LOCAL SCRATCH DATABASES ONLY (the test cluster user is a superuser). Never for production.
// stdout: aggregate counts only (no names, phones, amounts). Row-level data only in --report-file (local, mode 600).
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const spreadsheetId = arg("spreadsheet") ?? process.env.SHEETS_SPREADSHEET_ID;
const csvPath = arg("csv");
// Secrets: prefer *_FILE (a protected file) over a value in the environment.
const fromFile = (f?: string) => (f ? readFileSync(f, "utf8").trim() : undefined);
const readUrl = process.env.READ_URL ?? fromFile(process.env.READ_URL_FILE), stagingUrl = process.env.STAGING_URL ?? fromFile(process.env.STAGING_URL_FILE);
// Explicit production count check: the run stops before staging when the CRM does not hold what the owner expects.
const expectLeads = arg("expect-leads") === undefined ? undefined : Number(arg("expect-leads"));
const expectBookings = arg("expect-bookings") === undefined ? undefined : Number(arg("expect-bookings")); // ACTIVE CONFIRMED BOOKINGS only
const expectBlocks = arg("expect-blocks") === undefined ? undefined : Number(arg("expect-blocks")); // active manual blocks, counted separately
const allowEmptyCrm = arg("allow-empty-crm") === "yes";
if (!spreadsheetId || !readUrl || !csvPath) { console.error("need --spreadsheet/SHEETS_SPREADSHEET_ID, READ_URL (or READ_URL_FILE) and --csv <local-file>"); process.exit(2); }
if (stagingUrl && stagingUrl === readUrl) { console.error("STAGING_URL must differ from READ_URL"); process.exit(2); }
const hours = arg("hours") ? parseWorkingHours(arg("hours")) : null;
if (arg("hours") && !hours) { console.error("--hours must look like 10:00-23:00 and span at least four hours"); process.exit(2); }

const readPool = createPool(readUrl, { max: 1 });
try {
  const sheet = readCsv(readFileSync(csvPath, "utf8"), { spreadsheetId, sheetId: Number(arg("sheet-id") ?? 0), sheetTitle: arg("sheet") });
  const ro = await readPool.connect();
  let catalog, crm, access;
  try {
    await ro.query("BEGIN TRANSACTION READ ONLY");
    access = await checkReadAccess(ro);
    if (!access.ok && !(arg("allow-privileged-read-url") === "yes" && access.missing.length === 0 && access.rlsBlocked.length === 0)) {
      // Names of tables/columns only. A write-capable or incomplete READ_URL is refused before any row is read.
      throw new Error(`READ_URL not acceptable: missing=[${access.missing.join(",")}] writable=[${access.writable.join(",")}] superuser=${access.superuser} rlsBlocked=[${access.rlsBlocked.join(",")}]`);
    }
    catalog = await loadCatalog(ro);
    crm = await loadCrmSnapshot(ro, access.schema);
  } finally { await ro.query("ROLLBACK").catch(() => {}); ro.release(); }
  const crmCounts = { leads: crm.leads.length, activeBookings: crm.reservations.length, activeBlocks: crm.blocks.length };
  console.error(`production counts: leads=${crmCounts.leads} activeBookings=${crmCounts.activeBookings} activeBlocks=${crmCounts.activeBlocks}`); // numbers only
  const differs = (want: number | undefined, got: number) => want !== undefined && want !== got;
  if (differs(expectLeads, crmCounts.leads) || differs(expectBookings, crmCounts.activeBookings) || differs(expectBlocks, crmCounts.activeBlocks)) {
    console.error(`production counts differ from the expected leads=${expectLeads ?? "-"} activeBookings=${expectBookings ?? "-"} activeBlocks=${expectBlocks ?? "-"}: stopping before staging. Do not just rerun with the new numbers: first confirm independently (new real requests are normal, an empty or shrunken CRM is not).`);
    process.exit(3);
  }
  if (crmCounts.leads === 0 && !allowEmptyCrm) {
    // Zero rows must never be reported as "zero matches": it usually means the role sees nothing.
    console.error("the CRM snapshot has no leads at all: refusing to reconcile against an apparently empty CRM (pass --allow-empty-crm yes only for a genuinely empty scratch database)");
    process.exit(4);
  }
  const today = almatyToday();
  const rows = reconcile(sheet.rows.map((r) => normalizeRow(r.raw, r.source, catalog)), crm, today, hours ? { workingHours: hours } : {});
  const out: Record<string, unknown> = { input: "csv", spreadsheetTimeZone: sheet.spreadsheetTimeZone, crmSchema: access.schema, productionCounts: crmCounts, source: { csvSha256: createHash("sha256").update(readFileSync(csvPath)).digest("hex"), sheetRows: sheet.rows.length }, readRoleOverbroadTables: access.overbroadRead.length, workingHoursChecked: Boolean(hours), blankRowsIgnored: sheet.blankRows, ...summarize(rows, today) };
  if (stagingUrl) {
    const staging = createPool(stagingUrl, { max: 1 });
    try { await ensureStaging(staging); out.staging = await stageRows(staging, spreadsheetId, rows); } finally { await staging.end(); }
  }
  const reportFile = arg("report-file");
  if (reportFile) writeFileSync(reportFile, JSON.stringify(rows, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`dry run failed: ${(e as Error).message.split("\n")[0].slice(0, 300)}`); // never echo row data
  process.exitCode = 1;
} finally { await readPool.end(); }
