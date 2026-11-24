const CRM_SYNC_ID_CONFIG = Object.freeze({
  sheetName: "Лист1",
  headerName: "CRM Sync ID",
  protectionDescription: "Boom Bala CRM Sync ID — owner-managed",
  headerSearchRows: 50,
  maxRows: 600,
  maxCellCharacters: 1000,
  maxRequestBytes: 256 * 1024,
});
const CRM_SYNC_PROPERTY = Object.freeze({
  expectedSpreadsheetId: "CRM_SYNC_EXPECTED_SPREADSHEET_ID",
  ownerEmail: "CRM_SYNC_OWNER_EMAIL",
  endpoint: "CRM_SYNC_HTTPS_ENDPOINT",
  secret: "CRM_SYNC_HMAC_SECRET",
  mode: "CRM_SYNC_MODE",
  pendingId: "CRM_SYNC_PENDING_REQUEST_ID",
  pendingFingerprint: "CRM_SYNC_PENDING_FINGERPRINT",
});
const CRM_SYNC_ID_ALIASES = Object.freeze({
  sourceId: ["crm sync id", "sheets sync id", "source id", "id синхронизации", "id записи", "идентификатор записи", "crm id"],
  date: ["дата"], time: ["время"], package: ["пакет", "наименование пакет", "наименование пакета", "программа"],
  animator: ["аниматор"], room: ["комната", "кабинка", "зал"], client: ["клиент", "заказчик", "имя"],
  phone: ["телефон", "тел", "номер"], child: ["ребенок", "именинник", "имя ребенка"], age: ["возраст"],
  prepayment: ["предоплата"], children: ["количество детей", "кол во детей", "детей", "дет"],
  adults: ["количество взрослых", "кол во взрослых", "взрослых", "взр"], comment: ["комментарий", "примечание", "коммент", "comment", "notes"],
});

function setupCrmSyncIdAutomation() {
  const spreadsheet = openExpectedSpreadsheet_();
  assertExpectedSpreadsheet_(spreadsheet);
  assertSpreadsheetOwner_(spreadsheet);

  const sheet = spreadsheet.getSheetByName(CRM_SYNC_ID_CONFIG.sheetName);
  if (!sheet) throw new Error("crm_sync_sheet_not_found");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const header = findHeader_(sheet);
    ensureIdColumn_(sheet, header);
    protectIdColumn_(spreadsheet, sheet, header);
    assignIds_(sheet, header, header.headerRow + 1, sheet.getLastRow() - header.headerRow);
    installTrigger_(spreadsheet, "handleCrmSyncIdEdit", "edit");
    installTrigger_(spreadsheet, "handleCrmSyncIdChange", "change");
  } finally {
    lock.releaseLock();
  }
}

/** Installable edit trigger. Runs as the spreadsheet owner who installed it. */
function handleCrmSyncIdEdit(event) {
  if (!event || !event.source || !event.range) throw new Error("crm_sync_invalid_edit_event");
  assertExpectedSpreadsheet_(event.source);
  const sheet = event.range.getSheet();
  if (sheet.getName() !== CRM_SYNC_ID_CONFIG.sheetName) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const header = findHeader_(sheet);
    if (!header.idColumn) throw new Error("crm_sync_id_column_missing_run_setup");
    const firstRow = Math.max(event.range.getRow(), header.headerRow + 1);
    const lastRow = event.range.getLastRow();
    if (lastRow < firstRow) return;
    assignIds_(sheet, header, firstRow, lastRow - firstRow + 1, { repairDuplicatesInRange: true });
  } finally {
    lock.releaseLock();
  }
  pushSnapshot_();
}

/** Installable change trigger: catches row insertion and sort/other structural edits. */
function handleCrmSyncIdChange(event) {
  if (!event || !event.source) throw new Error("crm_sync_invalid_change_event");
  assertExpectedSpreadsheet_(event.source);
  if (!["INSERT_ROW", "INSERT_GRID", "OTHER"].includes(event.changeType)) return;

  const sheet = event.source.getSheetByName(CRM_SYNC_ID_CONFIG.sheetName);
  if (!sheet) throw new Error("crm_sync_sheet_not_found");
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const header = findHeader_(sheet);
    if (!header.idColumn) throw new Error("crm_sync_id_column_missing_run_setup");
    assignIds_(sheet, header, header.headerRow + 1, sheet.getLastRow() - header.headerRow);
  } finally {
    lock.releaseLock();
  }
  pushSnapshot_();
}

/** Owner-run, one-shot full reconciliation. Uses no Sheets API key or Google Cloud project. */
function syncSnapshotNow() {
  assertSpreadsheetOwner_(openExpectedSpreadsheet_());
  return pushSnapshot_();
}

/** Install only after the endpoint and automatic writes have received separate owner approval. */
function installLiveSyncTimer() {
  const spreadsheet = openExpectedSpreadsheet_();
  assertSpreadsheetOwner_(spreadsheet);
  if (!PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.endpoint) || !PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.secret)) {
    throw new Error("crm_sync_endpoint_or_secret_missing");
  }
  ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === "handleCrmSyncTimer"; })
    .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger("handleCrmSyncTimer").timeBased().everyMinutes(1).create();
}

function handleCrmSyncTimer() {
  pushSnapshot_();
}

function openExpectedSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.expectedSpreadsheetId) || "";
  if (!id) throw new Error("crm_sync_spreadsheet_id_property_missing");
  return SpreadsheetApp.openById(id);
}

function assertExpectedSpreadsheet_(spreadsheet) {
  const expectedId = PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.expectedSpreadsheetId) || "";
  if (!expectedId) throw new Error("crm_sync_spreadsheet_id_property_missing");
  if (!spreadsheet || spreadsheet.getId() !== expectedId) {
    throw new Error("crm_sync_wrong_spreadsheet");
  }
}

function assertSpreadsheetOwner_(spreadsheet) {
  assertExpectedSpreadsheet_(spreadsheet);
  const ownerEmail = (PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.ownerEmail) || "").toLowerCase();
  const effectiveEmail = (Session.getEffectiveUser().getEmail() || "").toLowerCase();
  if (!ownerEmail || !effectiveEmail || ownerEmail !== effectiveEmail) {
    throw new Error("crm_sync_setup_must_be_run_by_spreadsheet_owner");
  }
}

function normalizeHeader_(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

function findHeader_(sheet) {
  const columns = Math.max(sheet.getLastColumn(), 1);
  const rows = Math.min(CRM_SYNC_ID_CONFIG.headerSearchRows, Math.max(sheet.getLastRow(), 1));
  const values = sheet.getRange(1, 1, rows, columns).getDisplayValues();
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const cells = values[rowIndex].map(normalizeHeader_);
    const columns = cells.map((cell) => Object.entries(CRM_SYNC_ID_ALIASES).find(([, names]) => names.includes(cell))?.[0] || null);
    if (!columns.includes("date") || !columns.includes("time") || !columns.includes("phone")) continue;
    const idColumns = columns.flatMap((field, index) => field === "sourceId" ? [index + 1] : []);
    if (idColumns.length > 1) throw new Error("crm_sync_multiple_id_headers");
    const businessColumns = columns.flatMap((field, index) => field && field !== "sourceId" ? [index + 1] : []);
    return { headerRow: rowIndex + 1, idColumn: idColumns[0] || null, businessColumns, fieldByColumn: columns };
  }
  throw new Error("crm_sync_header_not_found");
}

function ensureIdColumn_(sheet, header) {
  if (header.idColumn) return;
  const column = sheet.getLastColumn() + 1;
  if (column > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
  sheet.getRange(header.headerRow, column).setValue(CRM_SYNC_ID_CONFIG.headerName);
  sheet.getRange(header.headerRow, column).setNote("Создаётся и поддерживается Apps Script. Не редактировать вручную.");
  header.idColumn = column;
}

function protectIdColumn_(spreadsheet, sheet, header) {
  const startRow = header.headerRow + 1;
  const range = sheet.getRange(startRow, header.idColumn, sheet.getMaxRows() - header.headerRow, 1);
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  let protection = protections.find((item) => item.getDescription() === CRM_SYNC_ID_CONFIG.protectionDescription);
  if (!protection) protection = range.protect();
  else protection.setRange(range);

  protection.setDescription(CRM_SYNC_ID_CONFIG.protectionDescription);
  protection.setWarningOnly(false);
  const ownerEmail = PropertiesService.getScriptProperties().getProperty(CRM_SYNC_PROPERTY.ownerEmail) || "";
  if (!ownerEmail) throw new Error("crm_sync_owner_email_unavailable");
  const editorEmails = new Set(protection.getEditors().map((editor) => editor.getEmail().toLowerCase()));
  for (const email of editorEmails) {
    if (email !== ownerEmail.toLowerCase()) protection.removeEditor(email);
  }
  if (!editorEmails.has(ownerEmail.toLowerCase())) protection.addEditor(ownerEmail);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

function pushSnapshot_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const spreadsheet = openExpectedSpreadsheet_();
    assertSpreadsheetOwner_(spreadsheet);
    const sheet = spreadsheet.getSheetByName(CRM_SYNC_ID_CONFIG.sheetName);
    if (!sheet) throw new Error("crm_sync_sheet_not_found");
    const header = findHeader_(sheet);
    if (!header.idColumn) throw new Error("crm_sync_id_column_missing_run_setup");
    assignIds_(sheet, header, header.headerRow + 1, sheet.getLastRow() - header.headerRow);
    const all = sheet.getDataRange().getDisplayValues();
    const rows = [];
    let blankRows = 0;
    for (let i = header.headerRow; i < all.length; i += 1) {
      const values = all[i];
      const raw = {};
      for (let column = 0; column < header.fieldByColumn.length; column += 1) {
        const field = header.fieldByColumn[column];
        if (field) {
          raw[field] = String(values[column] || "");
          if (raw[field].length > CRM_SYNC_ID_CONFIG.maxCellCharacters) throw new Error("crm_sync_cell_too_large");
        }
      }
      const hasContent = header.businessColumns.some(function (column) { return String(values[column - 1] || "").trim() !== ""; });
      if (!hasContent) { blankRows += 1; continue; }
      rows.push({ rowNumber: i + 1, raw: raw });
      if (rows.length > CRM_SYNC_ID_CONFIG.maxRows) throw new Error("crm_sync_too_many_rows");
    }
    const mode = properties.getProperty(CRM_SYNC_PROPERTY.mode) || "dry_run";
    if (mode !== "dry_run" && mode !== "apply") throw new Error("crm_sync_mode_invalid");
    const snapshot = {
      spreadsheetId: spreadsheet.getId(), sheetId: sheet.getSheetId(), sheetTitle: sheet.getName(),
      spreadsheetTimeZone: spreadsheet.getSpreadsheetTimeZone(), mode: mode, blankRows: blankRows, rows: rows,
    };
    const fingerprint = sha256_(JSON.stringify(snapshot));
    let requestId = properties.getProperty(CRM_SYNC_PROPERTY.pendingId) || "";
    if (!requestId || properties.getProperty(CRM_SYNC_PROPERTY.pendingFingerprint) !== fingerprint) {
      requestId = Utilities.getUuid();
      properties.setProperties({
        CRM_SYNC_PENDING_REQUEST_ID: requestId,
        CRM_SYNC_PENDING_FINGERPRINT: fingerprint,
      });
    }
    const payload = Object.assign({ requestId: requestId }, snapshot);
    const body = JSON.stringify(payload);
    if (Utilities.newBlob(body).getBytes().length > CRM_SYNC_ID_CONFIG.maxRequestBytes) throw new Error("crm_sync_payload_too_large");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = Utilities.getUuid();
    const secret = properties.getProperty(CRM_SYNC_PROPERTY.secret) || "";
    const endpoint = properties.getProperty(CRM_SYNC_PROPERTY.endpoint) || "";
    if (secret.length < 32 || !/^https:\/\//i.test(endpoint)) throw new Error("crm_sync_endpoint_or_secret_missing");
    const signatureBytes = Utilities.computeHmacSha256Signature(timestamp + "." + nonce + "." + body, secret, Utilities.Charset.UTF_8);
    const signature = signatureBytes.map(function (byte) { return (byte + 256).toString(16).slice(-2); }).join("");
    const response = UrlFetchApp.fetch(endpoint, {
      method: "post", contentType: "application/json", payload: body, followRedirects: false, muteHttpExceptions: true,
      headers: { "X-BB-Timestamp": timestamp, "X-BB-Nonce": nonce, "X-BB-Signature": signature },
    });
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) throw new Error("crm_sync_http_" + status);
    let result;
    try { result = JSON.parse(response.getContentText()); } catch (error) { throw new Error("crm_sync_invalid_response"); }
    if (!result || result.ok !== true || !result.result || !result.result.counts) throw new Error("crm_sync_invalid_response");
    properties.deleteProperty(CRM_SYNC_PROPERTY.pendingId);
    properties.deleteProperty(CRM_SYNC_PROPERTY.pendingFingerprint);
    properties.setProperty("CRM_SYNC_LAST_RESULT", JSON.stringify({ at: new Date().toISOString(), mode: result.result.mode, counts: result.result.counts }));
    return { mode: result.result.mode, counts: result.result.counts };
  } finally {
    lock.releaseLock();
  }
}

function sha256_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(function (byte) { return (byte + 256).toString(16).slice(-2); }).join("");
}

function assignIds_(sheet, header, startRow, rowCount, options) {
  if (rowCount <= 0) return;
  const lastColumn = Math.max(sheet.getLastColumn(), header.idColumn);
  const values = sheet.getRange(startRow, 1, rowCount, lastColumn).getDisplayValues();
  const idsRange = sheet.getRange(startRow, header.idColumn, rowCount, 1);
  const ids = idsRange.getDisplayValues().map((row) => String(row[0] || "").trim());
  const firstDataRow = header.headerRow + 1;
  const lastDataRow = Math.max(sheet.getLastRow(), header.headerRow);
  const allIds = lastDataRow >= firstDataRow
    ? sheet.getRange(firstDataRow, header.idColumn, lastDataRow - header.headerRow, 1).getDisplayValues().map((row) => String(row[0] || "").trim())
    : [];
  const idRows = new Map();
  for (let index = 0; index < allIds.length; index += 1) {
    const id = allIds[index];
    if (!id) continue;
    const rows = idRows.get(id) || [];
    rows.push(firstDataRow + index);
    idRows.set(id, rows);
  }

  let changed = false;
  const endRow = startRow + rowCount - 1;
  const existing = new Set(allIds.filter(Boolean));

  // Repair a copied UUID only when the edit event identifies the changed destination row and
  // there is exactly one occurrence outside that range. A structural event has no row range;
  // choosing the first duplicate after an insertion could silently transfer the original identity.
  for (const [duplicateId, rows] of idRows) {
    if (rows.length < 2) continue;
    const outside = rows.filter((row) => row < startRow || row > endRow);
    if (!options || options.repairDuplicatesInRange !== true || outside.length !== 1) {
      throw new Error("crm_sync_duplicate_id_requires_owner_reconcile");
    }
    const keeper = outside[0];
    for (const row of rows) {
      if (row === keeper || row < startRow || row > endRow) continue;
      const index = row - startRow;
      ids[index] = hasBusinessContent_(values[index], header.businessColumns) ? newUniqueId_(existing) : "";
      changed = true;
    }
    existing.add(duplicateId);
  }

  for (let index = 0; index < values.length; index += 1) {
    if (ids[index] || !hasBusinessContent_(values[index], header.businessColumns)) continue;
    ids[index] = newUniqueId_(existing);
    changed = true;
  }
  if (!changed) return;
  idsRange.setNumberFormat("@");
  idsRange.setValues(ids.map((id) => [id]));
}

function newUniqueId_(existing) {
  let id;
  do { id = Utilities.getUuid(); } while (existing.has(id));
  existing.add(id);
  return id;
}

function hasBusinessContent_(row, businessColumns) {
  return businessColumns.some((column) => String(row[column - 1] || "").trim() !== "");
}

function installTrigger_(spreadsheet, handler, type) {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  const builder = ScriptApp.newTrigger(handler).forSpreadsheet(spreadsheet);
  if (type === "edit") builder.onEdit().create();
  else builder.onChange().create();
}
