import { createSign } from "node:crypto";
import { isBlank, mapHeader, rowFromCells } from "./normalize.ts";
import type { RawRow, SourceRef } from "./types.ts";

export interface SheetRead {
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  spreadsheetTimeZone: string;
  rows: Array<{ raw: RawRow; source: SourceRef }>;
  blankRows: number;
}

/** Minimal surface so tests (and a future snapshot file) can stand in for Google. */
export interface SheetsClient {
  getMeta(spreadsheetId: string): Promise<{ timeZone: string; sheets: Array<{ sheetId: number; title: string; rowCount: number }> }>;
  getValues(spreadsheetId: string, a1Range: string): Promise<string[][]>;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Read-only service account client over Sheets API v4. The key is read from a file path, never logged or committed. */
export function googleSheetsClient(keyFile: { client_email: string; private_key: string }, fetchImpl: typeof fetch = fetch): SheetsClient {
  let token: { value: string; exp: number } | null = null;
  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.exp - 60 > now) return token.value;
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64u(JSON.stringify({ iss: keyFile.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(keyFile.private_key);
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64u(sig)}` }),
    });
    if (!res.ok) throw new Error(`google_token_failed:${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: now + j.expires_in };
    return token.value;
  }
  async function get(url: string): Promise<unknown> {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 403 || res.status === 404) throw new Error(`sheets_access_denied:${res.status} (share the sheet read-only with the service account)`);
    if (!res.ok) throw new Error(`sheets_api_failed:${res.status}`);
    return res.json();
  }
  return {
    async getMeta(id) {
      const j = (await get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.timeZone,sheets.properties(sheetId,title,gridProperties.rowCount)`)) as {
        properties: { timeZone: string }; sheets: Array<{ properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }>;
      };
      return { timeZone: j.properties.timeZone, sheets: j.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title, rowCount: s.properties.gridProperties.rowCount })) };
    },
    async getValues(id, range) {
      const j = (await get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`)) as { values?: string[][] };
      return j.values ?? [];
    },
  };
}

/** Reads the WHOLE used range of one sheet (not only the first rows). Blank rows are counted, never returned as bookings. */
export async function readSheet(client: SheetsClient, spreadsheetId: string, opts: { sheetTitle?: string } = {}): Promise<SheetRead> {
  const meta = await client.getMeta(spreadsheetId);
  const sheet = (opts.sheetTitle ? meta.sheets.find((s) => s.title === opts.sheetTitle) : meta.sheets[0]);
  if (!sheet) throw new Error("sheet_not_found");
  const quoted = `'${sheet.title.replace(/'/g, "''")}'`;
  const values = await client.getValues(spreadsheetId, quoted); // entire sheet: the API trims to the used range
  const headerIdx = values.findIndex((r) => mapHeader(r.map(String)) !== null);
  if (headerIdx < 0) throw new Error("header_not_found");
  const header = mapHeader(values[headerIdx].map(String))!;
  const rows: SheetRead["rows"] = [];
  let blankRows = 0;
  for (let i = headerIdx + 1; i < values.length; i++) {
    const raw = rowFromCells(values[i].map(String), header);
    if (isBlank(raw)) { blankRows++; continue; }
    rows.push({ raw, source: { spreadsheetId, sheetId: sheet.sheetId, rowNumber: i + 1 } });
  }
  return { spreadsheetId, sheetId: sheet.sheetId, sheetTitle: sheet.title, spreadsheetTimeZone: meta.timeZone, rows, blankRows };
}
