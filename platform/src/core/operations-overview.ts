/** Safe, allowlisted rows for the read-only upcoming birthday operations view. */

export const UPCOMING_OPERATIONS_DAYS = 7;
export const OPERATIONS_TIME_ZONE = "Asia/Almaty" as const;

export type OperationsReadRow = {
  id: string;
  date: string;
  kind: "booking" | "block";
  status: "confirmed" | "released" | "blocked";
  startsAt: string;
  room: string;
  packageName: string | null;
  paymentStatus: "prepaid" | "unpaid";
  paidKzt: number;
  sourceState: "active" | "manual_review" | "source_missing" | "crm_managed" | null;
  card: {
    programStatus: string | null;
    propsStatus: string | null;
    invitationStatus: string | null;
    responsibleName: string | null;
  } | null;
};

export type UpcomingBirthdayOperation = {
  id: string;
  date: string;
  startsAt: string;
  room: string;
  packageName: string;
  responsibleManager: string | null;
  programStatus: "approved" | "draft" | null;
  propsStatus: "not_started" | "preparing" | "ready" | null;
  invitationStatus: "not_applicable" | "not_started" | "in_progress" | "sent" | null;
  paymentFact:
    | { status: "confirmed"; amountKzt: number }
    | { status: "not_recorded" };
  recordStatus: "confirmed" | "manual_review" | "source_missing" | "crm_managed";
};

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/** Seven calendar dates beginning today in the caller's already-resolved Almaty date. */
export function upcomingOperationDates(today: string): string[] {
  const start = parseDate(today);
  if (!start) throw new RangeError("invalid_operations_date");
  return Array.from({ length: UPCOMING_OPERATIONS_DAYS }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

const almatyDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATIONS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateInAlmaty(instant: Date): string {
  const parts = almatyDateFormatter.formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function knownProgramStatus(value: string | null | undefined): "approved" | "draft" | null {
  return value === "approved" || value === "draft" ? value : null;
}

function knownPropsStatus(value: string | null | undefined): "not_started" | "preparing" | "ready" | null {
  return value === "not_started" || value === "preparing" || value === "ready" ? value : null;
}

function knownInvitationStatus(value: string | null | undefined): "not_applicable" | "not_started" | "in_progress" | "sent" | null {
  return value === "not_applicable" || value === "not_started" || value === "in_progress" || value === "sent" ? value : null;
}

/**
 * Keep confirmed CRM bookings and linked Sheets blocks distinct. Imported blocks remain visible for manual review;
 * they are never represented as confirmed bookings or financial facts.
 */
export function buildUpcomingBirthdayOperations(
  rows: OperationsReadRow[],
  now: Date = new Date(),
): UpcomingBirthdayOperation[] {
  if (Number.isNaN(now.getTime())) throw new RangeError("invalid_operations_now");
  const allowedDates = new Set(upcomingOperationDates(dateInAlmaty(now)));
  const nowMs = now.getTime();
  const result: UpcomingBirthdayOperation[] = [];

  for (const reservation of rows) {
    if (!allowedDates.has(reservation.date)) continue;
    const startMs = Date.parse(reservation.startsAt);
    if (!Number.isFinite(startMs) || startMs < nowMs || dateInAlmaty(new Date(startMs)) !== reservation.date) continue;

    const isConfirmedBooking = reservation.kind === "booking" && reservation.status === "confirmed";
    const isImportedBlock = reservation.kind === "block" && reservation.status === "blocked" && reservation.sourceState !== null;
    if (!isConfirmedBooking && !isImportedBlock) continue;

    const card = isConfirmedBooking ? reservation.card : null;
    const amount = reservation.paidKzt;
    const hasConfirmedManualFact = isConfirmedBooking && reservation.paymentStatus === "prepaid" && Number.isSafeInteger(amount) && amount > 0;
    const responsible = card?.responsibleName?.trim();
    result.push({
      id: reservation.id,
      date: reservation.date,
      startsAt: reservation.startsAt,
      room: reservation.room.trim() || "Помещение не указано",
      packageName: reservation.packageName?.trim() || "Пакет не указан",
      responsibleManager: responsible || null,
      programStatus: knownProgramStatus(card?.programStatus),
      propsStatus: knownPropsStatus(card?.propsStatus),
      invitationStatus: knownInvitationStatus(card?.invitationStatus),
      paymentFact: hasConfirmedManualFact
        ? { status: "confirmed", amountKzt: amount }
        : { status: "not_recorded" },
      recordStatus: isConfirmedBooking ? "confirmed" : reservation.sourceState === "source_missing" ? "source_missing" : reservation.sourceState === "crm_managed" ? "crm_managed" : "manual_review",
    });
  }

  return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
}
