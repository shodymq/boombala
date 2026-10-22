import type { Client, Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, NotFoundError, RetentionDisabledError, ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";

/**
 * Withdrawal of consent, anonymisation of a contact, and the retention report. See docs/platform/PRIVACY-LIFECYCLE.md.
 *
 * Nothing here deletes a row. A contact is anonymised (name and phone removed, indirect identifiers of its consent
 * history erased) only when nothing obliges us to keep it. What counts as an obligation is decided in ONE place,
 * `BLOCKERS` below, and is deliberately conservative: where the retention period is a legal question that is not
 * answered yet (closed enquiries, past bookings), the record is kept and reported, not invented away.
 */

export interface AuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Why a contact must not be anonymised. Codes only; the UI words them. */
export type Blocker =
  | "active_booking" // a booking that still holds a slot
  | "open_enquiry" // an enquiry that is new, in progress or confirmed
  | "booking_record" // any booking, also past or cancelled: retention period undecided (legal)
  | "enquiry_record"; // any enquiry, also closed: retention period undecided (legal)

export interface ErasureAssessment {
  contactId: string;
  anonymized: boolean;
  /** A published personal-data consent whose latest event for this contact is "given". */
  consentActive: boolean;
  blockers: Blocker[];
  registrations: number;
  lastRegistrationAt: Date | null;
}

export type ConsentNote = "subject_request" | "retention_expired" | "legal_request";

interface AssessRow {
  anonymized_at: Date | null;
  consent_active: boolean;
  active_booking: boolean;
  open_enquiry: boolean;
  booking_record: boolean;
  enquiry_record: boolean;
  registrations: number;
  last_registration_at: Date | null;
}

const ASSESS_SQL = `
  SELECT c.anonymized_at,
    EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (e.document_id) e.event
                             FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
                            WHERE e.contact_id = c.id AND d.kind = 'personal_data_consent'
                            ORDER BY e.document_id, e.occurred_at DESC, e.id DESC) x WHERE x.event = 'given') AS consent_active,
    EXISTS (SELECT 1 FROM bb.slot_reservations s WHERE s.contact_id = c.id AND s.released_at IS NULL) AS active_booking,
    EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.contact_id = c.id AND l.status IN ('new', 'in_progress', 'confirmed')) AS open_enquiry,
    EXISTS (SELECT 1 FROM bb.slot_reservations s WHERE s.contact_id = c.id) AS booking_record,
    EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.contact_id = c.id) AS enquiry_record,
    (SELECT count(*) FROM bb.consent_registrations r WHERE r.contact_id = c.id)::int AS registrations,
    (SELECT max(r.created_at) FROM bb.consent_registrations r WHERE r.contact_id = c.id) AS last_registration_at
  FROM bb.contacts c WHERE c.id = $1`;

function toAssessment(contactId: string, r: AssessRow): ErasureAssessment {
  const blockers: Blocker[] = [];
  if (r.active_booking) blockers.push("active_booking");
  if (r.open_enquiry) blockers.push("open_enquiry");
  if (r.booking_record) blockers.push("booking_record");
  if (r.enquiry_record) blockers.push("enquiry_record");
  return {
    contactId,
    anonymized: r.anonymized_at !== null,
    consentActive: r.consent_active,
    blockers,
    registrations: r.registrations,
    lastRegistrationAt: r.last_registration_at,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What may happen to a contact right now. Read-only; for the contact card and the tests. */
export async function assessContact(db: Queryable, actor: Actor, contactId: string): Promise<ErasureAssessment | null> {
  assertCan(actor, "privacy.manage");
  if (!UUID.test(contactId)) return null;
  const { rows } = await db.query<AssessRow>(ASSESS_SQL, [contactId]);
  return rows[0] ? toAssessment(contactId, rows[0]) : null;
}

async function lockContact(tx: Client, contactId: string): Promise<void> {
  if (!UUID.test(contactId)) throw new NotFoundError();
  // Writers that touch the contact (a new enquiry, a booking) wait here or make us wait: no race with the checks below.
  const { rows } = await tx.query("SELECT 1 FROM bb.contacts WHERE id = $1 FOR UPDATE", [contactId]);
  if (!rows[0]) throw new NotFoundError();
}

/** Appends a "revoked" event for every personal-data consent that is still "given". Returns how many. */
async function revokeInTx(tx: Client, actor: Actor, contactId: string, note: ConsentNote): Promise<number> {
  const active = await tx.query<{ document_id: string }>(
    `SELECT x.document_id FROM (
       SELECT DISTINCT ON (e.document_id) e.document_id, e.event
         FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
        WHERE e.contact_id = $1 AND d.kind = 'personal_data_consent'
        ORDER BY e.document_id, e.occurred_at DESC, e.id DESC) x
      WHERE x.event = 'given'`,
    [contactId],
  );
  for (const row of active.rows) {
    await tx.query(
      `INSERT INTO bb.consent_events (contact_id, document_id, event, method, note, recorded_by)
       VALUES ($1, $2, 'revoked', 'staff', $3, $4)`,
      [contactId, row.document_id, note, actor.id],
    );
  }
  await tx.query("UPDATE bb.contacts SET marketing_opt_in = false WHERE id = $1 AND marketing_opt_in", [contactId]);
  return active.rows.length;
}

export interface RevokeResult {
  revokedDocuments: number;
  /** Nothing to revoke: already revoked, never given, or the contact is already anonymised. */
  nothingToRevoke: boolean;
  assessment: ErasureAssessment;
}

/**
 * Records that the person withdrew consent (history only grows). Repeating it changes nothing. This does NOT erase
 * anything by itself: whether the data may go is answered by `assessContact` / `anonymizeContact`.
 */
export async function revokeConsent(pool: Pool, actor: Actor, contactId: string, meta: AuditMeta = {}, note: ConsentNote = "subject_request"): Promise<RevokeResult> {
  assertCan(actor, "privacy.manage");
  return withTx(pool, async (tx) => {
    await lockContact(tx, contactId);
    const before = toAssessment(contactId, (await tx.query<AssessRow>(ASSESS_SQL, [contactId])).rows[0]);
    let revoked = 0;
    if (!before.anonymized) revoked = await revokeInTx(tx, actor, contactId, note);
    if (revoked > 0) {
      await writeAudit(tx, { actorUserId: actor.id, action: "consent.revoked", entityType: "contact", entityId: contactId, after: { documents: revoked, reason: note }, ...meta });
    }
    return { revokedDocuments: revoked, nothingToRevoke: revoked === 0, assessment: toAssessment(contactId, (await tx.query<AssessRow>(ASSESS_SQL, [contactId])).rows[0]) };
  });
}

export interface AnonymizeResult {
  anonymized: boolean;
  /** Was anonymised before: nothing was done. */
  already: boolean;
  erasedEventIdentifiers: number;
}

export const ANONYMIZED_NAME = "Анонимизировано";

/**
 * Removes name and phone of a contact and erases the indirect identifiers (IP hash, browser string) on its consent
 * history. The history rows, enquiries and bookings stay, tied to a contact that no longer identifies anyone.
 *  - `subject_request` (default): the consent must have been revoked first.
 *  - `retention_expired`: used by the retention run; records the revocation itself.
 * Refuses (ConflictError with the blocker codes) while anything obliges us to keep the contact.
 */
export async function anonymizeContact(
  pool: Pool,
  actor: Actor,
  contactId: string,
  meta: AuditMeta = {},
  basis: "subject_request" | "retention_expired" = "subject_request",
): Promise<AnonymizeResult> {
  assertCan(actor, "privacy.manage");
  return withTx(pool, async (tx) => {
    await lockContact(tx, contactId);
    const a = toAssessment(contactId, (await tx.query<AssessRow>(ASSESS_SQL, [contactId])).rows[0]);
    if (a.anonymized) return { anonymized: false, already: true, erasedEventIdentifiers: 0 };
    if (a.blockers.length) throw new ConflictError(`blocked:${a.blockers.join(",")}`);
    if (basis === "subject_request" && a.consentActive) throw new ConflictError("consent_not_revoked");
    if (basis === "retention_expired") await revokeInTx(tx, actor, contactId, "retention_expired");

    await tx.query(
      "UPDATE bb.contacts SET name = $2, name_key = 'anon:' || id::text, phone_e164 = NULL, marketing_opt_in = false, anonymized_at = now() WHERE id = $1",
      [contactId, ANONYMIZED_NAME],
    );
    const erased = await tx.query(
      "UPDATE bb.consent_events SET ip_hash = NULL, user_agent = NULL WHERE contact_id = $1 AND (ip_hash IS NOT NULL OR user_agent IS NOT NULL)",
      [contactId],
    );
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "contact.anonymized",
      entityType: "contact",
      entityId: contactId,
      after: { basis, erasedEventIdentifiers: erased.rowCount ?? 0 },
      ...meta,
    });
    return { anonymized: true, already: false, erasedEventIdentifiers: erased.rowCount ?? 0 };
  });
}

// ── Retention ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RetentionSettings {
  qrMonths: number;
  autoEnabled: boolean;
  legalConfirmedAt: Date | null;
}

export async function getRetentionSettings(db: Queryable, actor: Actor): Promise<RetentionSettings> {
  assertCan(actor, "privacy.manage");
  const { rows } = await db.query("SELECT qr_months, auto_enabled, legal_confirmed_at FROM bb.retention_settings");
  return { qrMonths: Number(rows[0].qr_months), autoEnabled: rows[0].auto_enabled, legalConfirmedAt: rows[0].legal_confirmed_at };
}

export interface RetentionSettingsInput {
  qrMonths?: number;
  autoEnabled?: boolean;
  /** true records the confirmation (who and when); false withdraws it and switches automatic processing off. */
  legalConfirmed?: boolean;
}

export async function updateRetentionSettings(pool: Pool, actor: Actor, input: RetentionSettingsInput, meta: AuditMeta = {}): Promise<RetentionSettings> {
  assertCan(actor, "privacy.manage");
  const errors: Record<string, string> = {};
  if (input.qrMonths !== undefined && !(Number.isInteger(input.qrMonths) && input.qrMonths >= 1 && input.qrMonths <= 120)) errors.qrMonths = "От 1 до 120 месяцев";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return withTx(pool, async (tx) => {
    const cur = (await tx.query("SELECT qr_months, auto_enabled, legal_confirmed_at FROM bb.retention_settings FOR UPDATE")).rows[0];
    const confirmed = input.legalConfirmed === undefined ? cur.legal_confirmed_at !== null : input.legalConfirmed;
    const auto = input.legalConfirmed === false ? false : (input.autoEnabled ?? cur.auto_enabled);
    if (auto && !confirmed) throw new ValidationError({ autoEnabled: "Сначала нужно записать юридическое подтверждение срока" });
    const months = input.qrMonths ?? Number(cur.qr_months);
    await tx.query(
      `UPDATE bb.retention_settings SET qr_months = $1, auto_enabled = $2, updated_at = now(),
         legal_confirmed_at = CASE WHEN $3::boolean AND legal_confirmed_at IS NULL THEN now() WHEN NOT $3::boolean THEN NULL ELSE legal_confirmed_at END,
         legal_confirmed_by = CASE WHEN $3::boolean AND legal_confirmed_at IS NULL THEN $4::uuid WHEN NOT $3::boolean THEN NULL ELSE legal_confirmed_by END`,
      [months, auto, confirmed, actor.id],
    );
    const after = { qrMonths: months, autoEnabled: auto, legalConfirmed: confirmed };
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "retention.settings_changed",
      entityType: "retention_settings",
      before: { qrMonths: Number(cur.qr_months), autoEnabled: cur.auto_enabled, legalConfirmed: cur.legal_confirmed_at !== null },
      after,
      ...meta,
    });
    return getRetentionSettings(tx, actor);
  });
}

export interface RetentionItem {
  contactId: string;
  lastRegistrationAt: Date;
}
export interface RetentionBlockedItem extends RetentionItem {
  blockers: Blocker[];
}

export interface RetentionReport {
  asOf: Date;
  settings: RetentionSettings;
  totals: {
    /** Contacts with at least one QR registration that are not anonymised yet. */
    qrContacts: number;
    /** Last registration is younger than the period. */
    notExpired: number;
    /** Period passed and nothing obliges us to keep the contact: would be anonymised by a real run. */
    eligible: number;
    /** Period passed but the contact is tied to an enquiry or a booking: must not be touched. */
    blocked: number;
    alreadyAnonymized: number;
    /** Contacts without any QR registration (enquiry/booking only): outside this rule. */
    outsideQrRule: number;
  };
  /** Identifiers only, never names or phones. Lists are capped; `truncated` says so. */
  eligible: RetentionItem[];
  blocked: RetentionBlockedItem[];
  truncated: boolean;
}

const LIST_CAP = 500;

/** DRY RUN: changes nothing. Which contacts a retention run would process, and which it must leave alone. */
export async function retentionReport(db: Queryable, actor: Actor, now: Date = new Date()): Promise<RetentionReport> {
  assertCan(actor, "privacy.manage");
  const settings = await getRetentionSettings(db, actor);
  const { rows } = await db.query<AssessRow & { id: string; expired: boolean }>(
    `SELECT c.id, (SELECT max(r.created_at) + make_interval(months => $1::int) <= $2::timestamptz FROM bb.consent_registrations r WHERE r.contact_id = c.id) AS expired,
            a.*
       FROM bb.contacts c
       CROSS JOIN LATERAL (
         SELECT c.anonymized_at,
           false AS consent_active,
           EXISTS (SELECT 1 FROM bb.slot_reservations s WHERE s.contact_id = c.id AND s.released_at IS NULL) AS active_booking,
           EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.contact_id = c.id AND l.status IN ('new', 'in_progress', 'confirmed')) AS open_enquiry,
           EXISTS (SELECT 1 FROM bb.slot_reservations s WHERE s.contact_id = c.id) AS booking_record,
           EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.contact_id = c.id) AS enquiry_record,
           (SELECT count(*) FROM bb.consent_registrations r WHERE r.contact_id = c.id)::int AS registrations,
           (SELECT max(r.created_at) FROM bb.consent_registrations r WHERE r.contact_id = c.id) AS last_registration_at
       ) a
      ORDER BY a.last_registration_at NULLS LAST, c.id`,
    [settings.qrMonths, now.toISOString()],
  );
  const report: RetentionReport = {
    asOf: now,
    settings,
    totals: { qrContacts: 0, notExpired: 0, eligible: 0, blocked: 0, alreadyAnonymized: 0, outsideQrRule: 0 },
    eligible: [],
    blocked: [],
    truncated: false,
  };
  for (const r of rows) {
    if (r.anonymized_at) {
      report.totals.alreadyAnonymized++;
      continue;
    }
    if (r.registrations === 0 || !r.last_registration_at) {
      report.totals.outsideQrRule++;
      continue;
    }
    report.totals.qrContacts++;
    if (!r.expired) {
      report.totals.notExpired++;
      continue;
    }
    const a = toAssessment(r.id, r);
    const item = { contactId: r.id, lastRegistrationAt: r.last_registration_at };
    if (a.blockers.length) {
      report.totals.blocked++;
      if (report.blocked.length < LIST_CAP) report.blocked.push({ ...item, blockers: a.blockers });
      else report.truncated = true;
    } else {
      report.totals.eligible++;
      if (report.eligible.length < LIST_CAP) report.eligible.push(item);
      else report.truncated = true;
    }
  }
  return report;
}

export interface RetentionRunResult {
  dryRun: boolean;
  report: RetentionReport;
  processed: number;
  /** Became blocked or vanished between the report and the processing: left untouched. */
  skipped: number;
}

/**
 * `dryRun` (the default) only reports. A real run needs the Owner, `auto_enabled` AND a recorded legal confirmation,
 * otherwise it throws RetentionDisabledError and changes nothing. No route, cron or job calls this: it is an explicit,
 * manual act until the retention period is legally confirmed.
 */
export async function runRetention(pool: Pool, actor: Actor, opts: { dryRun?: boolean; now?: Date } = {}, meta: AuditMeta = {}): Promise<RetentionRunResult> {
  assertCan(actor, "privacy.manage");
  const dryRun = opts.dryRun !== false;
  const report = await retentionReport(pool, actor, opts.now ?? new Date());
  if (dryRun) return { dryRun: true, report, processed: 0, skipped: 0 };
  if (!report.settings.autoEnabled || !report.settings.legalConfirmedAt) throw new RetentionDisabledError();
  let processed = 0;
  let skipped = 0;
  for (const item of report.eligible) {
    try {
      const r = await anonymizeContact(pool, actor, item.contactId, meta, "retention_expired");
      if (r.anonymized) processed++;
      else skipped++;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) skipped++;
      else throw error;
    }
  }
  await writeAudit(pool, { actorUserId: actor.id, action: "retention.run", entityType: "retention_settings", after: { processed, skipped, qrMonths: report.settings.qrMonths }, ...meta });
  return { dryRun: false, report, processed, skipped };
}
