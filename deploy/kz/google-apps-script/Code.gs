const CRM_SYNC_ID_CONFIG = Object.freeze({
  sheetName: "Лист1",
  headerName: "CRM Sync ID",
  protectionDescription: "Boom Bala CRM Sync ID — owner-managed",
  headerSearchRows: 50,
});

function setupCrmSyncIdAutomation() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  assertExpectedSpreadsheet_(spreadsheet);
  assertSpreadsheetOwner_(spreadsheet);

  const sheet = spreadsheet.getSheetByName(CRM_SYNC_ID_CONFIG.sheetName);
  if (!sheet) throw new Error("crm_sync_sheet_not_found");

  const lock = LockService.getDocumentLock();
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

  const lock = LockService.getDocumentLock();
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
}

/** Installable change trigger: catches row insertion and sort/other structural edits. */
function handleCrmSyncIdChange(event) {
  if (!event || !event.source) throw new Error("crm_sync_invalid_change_event");
  assertExpectedSpreadsheet_(event.source);
  if (!["INSERT_ROW", "INSERT_GRID", "OTHER"].includes(event.changeType)) return;

  const sheet = event.source.getSheetByName(CRM_SYNC_ID_CONFIG.sheetName);
  if (!sheet) throw new Error("crm_sync_sheet_not_found");
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const header = findHeader_(sheet);
    if (!header.idColumn) throw new Error("crm_sync_id_column_missing_run_setup");
    assignIds_(sheet, header, header.headerRow + 1, sheet.getLastRow() - header.headerRow);
  } finally {
    lock.releaseLock();
  }
}

function assertExpectedSpreadsheet_(spreadsheet) {
  const expectedId = PropertiesService.getScriptProperties().getProperty("CRM_SYNC_EXPECTED_SPREADSHEET_ID") || "";
  if (!expectedId) throw new Error("crm_sync_spreadsheet_id_property_missing");
  if (!spreadsheet || spreadsheet.getId() !== expectedId) {
    throw new Error("crm_sync_wrong_spreadsheet");
  }
}

function assertSpreadsheetOwner_(spreadsheet) {
  const owner = DriveApp.getFileById(spreadsheet.getId()).getOwner();
  const effectiveEmail = (Session.getEffectiveUser().getEmail() || "").toLowerCase();
  const ownerEmail = owner ? (owner.getEmail() || "").toLowerCase() : "";
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
  const aliases = {
    sourceId: ["crm sync id", "sheets sync id", "source id", "id синхронизации", "id записи", "идентификатор записи", "crm id"],
    date: ["дата"], time: ["время"], package: ["пакет", "наименование пакет", "наименование пакета", "программа"],
    animator: ["аниматор"], room: ["комната", "кабинка", "зал"], client: ["клиент", "заказчик", "имя"],
    phone: ["телефон", "тел", "номер"], child: ["ребенок", "именинник", "имя ребенка"], age: ["возраст"],
    prepayment: ["предоплата"], children: ["количество детей", "кол во детей", "детей", "дет"],
    adults: ["количество взрослых", "кол во взрослых", "взрослых", "взр"], comment: ["комментарий", "примечание", "коммент", "comment", "notes"],
  };
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const cells = values[rowIndex].map(normalizeHeader_);
    const columns = cells.map((cell) => Object.entries(aliases).find(([, names]) => names.includes(cell))?.[0] || null);
    if (!columns.includes("date") || !columns.includes("time") || !columns.includes("phone")) continue;
    const idColumns = columns.flatMap((field, index) => field === "sourceId" ? [index + 1] : []);
    if (idColumns.length > 1) throw new Error("crm_sync_multiple_id_headers");
    const businessColumns = columns.flatMap((field, index) => field && field !== "sourceId" ? [index + 1] : []);
    return { headerRow: rowIndex + 1, idColumn: idColumns[0] || null, businessColumns };
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
  const owner = DriveApp.getFileById(spreadsheet.getId()).getOwner();
  const ownerEmail = owner && owner.getEmail();
  if (!ownerEmail) throw new Error("crm_sync_owner_email_unavailable");
  const editorEmails = new Set(protection.getEditors().map((editor) => editor.getEmail().toLowerCase()));
  for (const email of editorEmails) {
    if (email !== ownerEmail.toLowerCase()) protection.removeEditor(email);
  }
  if (!editorEmails.has(ownerEmail.toLowerCase())) protection.addEditor(ownerEmail);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
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
