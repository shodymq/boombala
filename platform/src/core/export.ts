import writeXlsxFile from "write-excel-file/node";
import type { Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { isValidDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import { assertCanExport, type Actor } from "./rbac.ts";
import { contactWhere, type ContactFilters } from "./crm.ts";
import type { RequestMeta } from "./users.ts";

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

interface ColumnDef {
  header: string;
  sql: string;
}

/** Whitelist: the client names columns, never SQL. */
export const EXPORT_COLUMNS = {
  id: { header: "ID", sql: "c.id::text" },
  name: { header: "Имя", sql: "c.name" },
  phone: { header: "Телефон", sql: "c.phone_e164" },
  source: { header: "Источник", sql: "c.source" },
  first_registered_at: { header: "Первая регистрация", sql: "to_char(c.first_registered_at AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD HH24:MI')" },
  last_activity_at: { header: "Последняя активность", sql: "to_char(c.last_activity_at AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD HH24:MI')" },
  phone_verification: { header: "Подтверждение телефона", sql: "c.phone_verification" },
  leads_count: { header: "Заявок", sql: "(SELECT count(*) FROM bb.lead_requests l WHERE l.contact_id = c.id)::text" },
  registrations_count: { header: "QR-регистраций", sql: "(SELECT count(*) FROM bb.consent_registrations r WHERE r.contact_id = c.id)::text" },
  last_consent: {
    header: "Последнее согласие (документ, версия)",
    sql: `COALESCE((SELECT d.kind::text || ' v' || d.version FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
                WHERE e.contact_id = c.id AND d.kind = 'personal_data_consent' ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1), '')`,
  },
} as const satisfies Record<string, ColumnDef>;
export type ExportColumn = keyof typeof EXPORT_COLUMNS;
export const DEFAULT_EXPORT_COLUMNS: ExportColumn[] = ["name", "phone", "source", "first_registered_at", "last_activity_at", "phone_verification"];
const MAX_ROWS = 50_000;

/**
 * Spreadsheet formula injection guard: a text cell starting with = + - @ TAB CR is neutralised with a leading apostrophe.
 * Strict normalised phone numbers (+7…) are the only exception, because they are data, not formulas.
 */
export function guardCell(value: string): string {
  if (/^\+[1-9]\d{9,14}$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const v = guardCell(value);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface ExportRequest {
  format: ExportFormat;
  columns?: string[];
  from?: string;
  to?: string;
  filters?: Omit<ContactFilters, "from" | "to">;
}

export interface ExportResult {
  filename: string;
  contentType: string;
  body: Buffer;
  rowCount: number;
}

/**
 * Exports contacts. Authorisation first (nothing is queried for a forbidden user and nothing is logged as an export);
 * for an allowed user the export_log row and the audit entry are committed BEFORE the file is returned.
 */
export async function exportContacts(pool: Pool, actor: Actor, req: ExportRequest, meta: RequestMeta = {}): Promise<ExportResult> {
  assertCanExport(actor);

  const errors: Record<string, string> = {};
  if (!(EXPORT_FORMATS as readonly string[]).includes(req.format)) errors.format = "Формат: CSV или XLSX";
  const requested = req.columns?.length ? req.columns : DEFAULT_EXPORT_COLUMNS;
  const columns = [...new Set(requested)];
  if (!columns.every((c) => Object.hasOwn(EXPORT_COLUMNS, c))) errors.columns = "Неизвестный столбец";
  if (req.from && !isValidDate(req.from)) errors.from = "Некорректная дата";
  if (req.to && !isValidDate(req.to)) errors.to = "Некорректная дата";
  if (req.from && req.to && req.from > req.to) errors.to = "Конец периода раньше начала";
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const cols = columns as ExportColumn[];
  const filters: ContactFilters = { ...req.filters, from: req.from, to: req.to };
  const { sql, params } = contactWhere(filters);

  const { rows, stamp } = await withTx(pool, async (tx) => {
    const res = await tx.query<Record<string, string>>(
      `SELECT ${cols.map((c, i) => `${EXPORT_COLUMNS[c].sql} AS c${i}`).join(", ")}
         FROM bb.contacts c ${sql} ORDER BY c.first_registered_at, c.id LIMIT ${MAX_ROWS + 1}`,
      params,
    );
    if (res.rows.length > MAX_ROWS) throw new ValidationError({ to: `Слишком много строк (больше ${MAX_ROWS}): сузьте период` });
    // The free-text search may be a name or a phone: the log is append-only, so only the fact that one was used is kept.
    const logged = { ...req.filters, ...(req.filters?.q ? { q: "[redacted]" } : {}) };
    await tx.query(
      "INSERT INTO bb.export_log (user_id, format, date_from, date_to, filters, columns, row_count, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [actor.id, req.format, req.from ?? null, req.to ?? null, JSON.stringify(logged), cols, res.rows.length, meta.ip ?? null],
    );
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "contacts.exported",
      entityType: "export",
      after: { format: req.format, from: req.from ?? null, to: req.to ?? null, columns: cols, rows: res.rows.length },
      ...meta,
    });
    return { rows: res.rows, stamp: new Date().toISOString().slice(0, 10) };
  });

  const headers = cols.map((c) => EXPORT_COLUMNS[c].header);
  const table = rows.map((r) => cols.map((_, i) => String(r[`c${i}`] ?? "")));
  const filename = `boombala-contacts-${stamp}.${req.format}`;

  if (req.format === "csv") {
    const text = [headers, ...table].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
    return { filename, contentType: "text/csv; charset=utf-8", body: Buffer.concat([Buffer.from("﻿"), Buffer.from(text, "utf8")]), rowCount: rows.length };
  }
  const sheet = [headers.map((h) => ({ value: h, fontWeight: "bold" as const })), ...table.map((line) => line.map((v) => ({ value: guardCell(v), type: String })))];
  const body = Buffer.from(await writeXlsxFile(sheet as never, { sheet: "Контакты" } as never).toBuffer());
  return { filename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body, rowCount: rows.length };
}
