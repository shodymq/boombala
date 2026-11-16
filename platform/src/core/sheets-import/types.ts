/** Where a row came from. Rows move in a spreadsheet, so the row number is a hint; identity is `sourceKey`. */
export interface SourceRef {
  spreadsheetId: string;
  sheetId: number;
  /** 1-based row number at read time (informational only: it changes when rows are inserted or sorted). */
  rowNumber: number;
}

/** Raw cells exactly as the Sheets API returned them (FORMATTED_VALUE), keyed by canonical column. */
export type RawRow = Partial<Record<Column, string>>;

export const COLUMNS = [
  "date", "time", "package", "animator", "room", "client", "phone", "child", "age", "prepayment", "children", "adults",
] as const;
export type Column = (typeof COLUMNS)[number];

export type ImportStatus =
  | "CANDIDATE" // clean, future, no conflicts: may become a booking after manager approval
  | "NEEDS_REVIEW" // anything ambiguous or conflicting
  | "ALREADY_IN_CRM" // matched an existing production record
  | "ARCHIVE_ONLY" // past event: history, never a booking
  | "IGNORED_EMPTY"; // no business content

export type Reason =
  | "date_unparseable" | "date_missing" | "time_unparseable" | "time_missing" | "outside_working_hours"
  | "room_unknown" | "room_ambiguous" | "room_missing" | "package_unknown" | "package_missing"
  | "phone_invalid" | "phone_missing" | "client_missing"
  | "prepayment_unverified" | "no_prepayment" | "prepayment_unparseable"
  | "duplicate_in_sheet" | "overlap_in_sheet" | "overlap_with_crm" | "matches_crm_conflicting"
  | "children_unparseable" | "age_unparseable" | "past_event" | "unknown_status_text"
  | "no_confirmation_flag" | "time_semantics_unconfirmed";

export interface NormalizedRow {
  source: SourceRef;
  /** Stable identity of the business record, independent of row position. */
  sourceKey: string;
  /** Hash of every normalized value: changes when the manager edits the row. */
  fingerprint: string;
  date: string | null; // YYYY-MM-DD
  /** Venue wall-clock HH:MM exactly as written (any valid minute; never rounded, never timezone-shifted). */
  time: string | null;
  roomId: string | null;
  roomRaw: string;
  packageId: string | null;
  packageRaw: string;
  animator: string;
  customerName: string;
  phoneE164: string | null;
  childName: string;
  childAge: number | null;
  children: number | null;
  adults: number | null;
  /** A manager-entered amount. A CANDIDATE for a payment fact, never a confirmed payment. */
  prepaymentCandidateKzt: number | null;
  prepaymentRaw: string;
  status: ImportStatus;
  reasons: Reason[];
}

export interface Catalog {
  rooms: Array<{ id: string; name: string }>;
  packages: Array<{ id: string; name: string }>;
}

/** Read-only snapshot of what CRM already holds. No payment or secret fields. */
export interface CrmSnapshot {
  leads: Array<{ id: string; date: string; phoneE164: string; nameKey: string; children: number | null; packageId: string | null; roomId: string | null; status: string }>;
  reservations: Array<{ id: string; date: string; startTime: string; roomId: string; phoneE164: string | null; children: number | null; packageId: string | null }>;
}
