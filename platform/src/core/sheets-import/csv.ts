import { isBlank, mapHeader, rowFromCells } from "./normalize.ts";
import type { SheetRead } from "./types.ts";

/** RFC 4180 parser (quotes, doubled quotes, CRLF, BOM). Delimiter is detected from the header line: `,` or `;` or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * A CSV exported from Google Sheets ("File > Download > CSV") goes through exactly the same header mapping, blank-row
 * handling, normalizer and reconciliation as the API reader. Use the real spreadsheet and sheet ids so that source keys
 * are identical to the API path: a later API run then updates the same records instead of duplicating them.
 * Errors never contain cell contents.
 */
export function readCsv(text: string, ids: { spreadsheetId: string; sheetId: number; sheetTitle?: string }): SheetRead {
  const values = parseCsv(text);
  const headerIdx = values.findIndex((r) => mapHeader(r) !== null);
  if (headerIdx < 0) throw new Error("header_not_found");
  const header = mapHeader(values[headerIdx])!;
  const rows: SheetRead["rows"] = [];
  let blankRows = 0;
  for (let i = headerIdx + 1; i < values.length; i++) {
    const raw = rowFromCells(values[i], header);
    if (isBlank(raw)) { blankRows++; continue; }
    rows.push({ raw, source: { spreadsheetId: ids.spreadsheetId, sheetId: ids.sheetId, rowNumber: i + 1 } });
  }
  return { spreadsheetId: ids.spreadsheetId, sheetId: ids.sheetId, sheetTitle: ids.sheetTitle ?? "csv", spreadsheetTimeZone: "unknown(csv)", rows, blankRows };
}
