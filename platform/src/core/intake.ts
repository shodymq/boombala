import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Client, Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ConsentUnavailableError, ValidationError } from "./errors.ts";
import { cleanName, nameKey, normalizePhone } from "./phone.ts";

export interface IntakeMeta {
  ip?: string | null;
  userAgent?: string | null;
  /** Server secret for hashing the IP; the raw IP is never stored with a consent. */
  ipPepper?: string;
}

/** HMAC of the address: lets us see "same device" in an audit without keeping the address itself. */
export function hashIp(ip: string | null | undefined, pepper: string | undefined): string | null {
  if (!ip || ip === "unknown" || !pepper) return null;
  return createHmac("sha256", pepper).update(ip).digest("hex").slice(0, 32);
}

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const idSchema = z.string().trim().regex(/^[a-z0-9-]{1,60}$/);

const leadSchema = z.object({
  idempotencyKey: z.string().uuid("Некорректный ключ"),
  name: z.string().trim().min(1, "Укажите имя").max(120, "Слишком длинное имя"),
  phone: z.string().trim().min(5, "Укажите телефон").max(40),
  date: z.string().trim(),
  children: z.union([z.number().int().min(0).max(200), z.string().regex(/^\d{1,3}$/).transform(Number)]).optional().nullable(),
  packageId: idSchema.optional().nullable(),
  roomId: idSchema.optional().nullable(),
  slotId: z.union([z.number().int().min(1).max(3), z.string().regex(/^[1-3]$/).transform(Number)]).optional().nullable(),
  consent: z.literal(true, "Необходимо согласие"),
  page: optText(200),
  referrer: optText(300),
  utmSource: optText(100),
  utmMedium: optText(100),
  utmCampaign: optText(100),
});

export type LeadInput = z.input<typeof leadSchema>;

const consentSchema = z.object({
  idempotencyKey: z.string().uuid("Некорректный ключ"),
  name: z.string().trim().min(1, "Укажите имя").max(120, "Слишком длинное имя"),
  phone: z.string().trim().min(5, "Укажите телефон").max(40),
  acceptRules: z.literal(true, "Необходимо подтвердить ознакомление с правилами"),
  acceptPersonalData: z.literal(true, "Необходимо согласие на обработку данных"),
});

export type ConsentInput = z.input<typeof consentSchema>;

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}

async function upsertContact(tx: Client, name: string, phone: string, source: "qr" | "birthday_form"): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_e164, name_key) DO UPDATE SET last_activity_at = now()
     RETURNING id`,
    [name, nameKey(name), phone, source],
  );
  return rows[0].id;
}

async function publishedDoc(tx: Client, kind: string): Promise<{ id: string; version: number } | null> {
  const { rows } = await tx.query<{ id: string; version: number }>("SELECT id, version FROM bb.legal_documents WHERE kind = $1 AND status = 'published'", [kind]);
  return rows[0] ?? null;
}

export interface LeadResult {
  leadId: string;
  seq: number;
  duplicate: boolean;
}

/**
 * Saves an enquiry: contact, enquiry, consent event and the Telegram notification task in ONE transaction. Repeating the
 * same idempotency key (double click, retry, parallel request) returns the first result and creates nothing new.
 */
export async function submitLead(pool: Pool, raw: LeadInput, meta: IntakeMeta = {}): Promise<LeadResult> {
  const parsed = leadSchema.safeParse(raw);
  const errors: Record<string, string> = parsed.success ? {} : fieldErrors(parsed.error);
  const input = parsed.success ? parsed.data : null;
  const phone = input ? normalizePhone(input.phone) : null;
  if (input && !phone) errors.phone = "Проверьте номер телефона";
  if (input && !(isValidDate(input.date) && input.date >= almatyToday())) errors.date = "Выберите дату не раньше сегодняшней";
  if (Object.keys(errors).length || !input || !phone) throw new ValidationError(errors);

  const name = cleanName(input.name);
  const packageId = input.packageId && input.packageId !== "undecided" ? input.packageId : null;
  const roomId = input.roomId || null;

  return withTx(pool, async (tx) => {
    const existing = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.lead_requests WHERE idempotency_key = $1", [input.idempotencyKey]);
    if (existing.rows[0]) return { leadId: existing.rows[0].id, seq: Number(existing.rows[0].seq), duplicate: true };

    const consentDoc = await publishedDoc(tx, "personal_data_consent");
    if (!consentDoc) throw new ConsentUnavailableError();
    if (packageId && !(await tx.query("SELECT 1 FROM bb.packages WHERE id = $1 AND is_active", [packageId])).rowCount) throw new ValidationError({ packageId: "Неизвестный пакет" });
    if (roomId && !(await tx.query("SELECT 1 FROM bb.rooms WHERE id = $1 AND is_active", [roomId])).rowCount) throw new ValidationError({ roomId: "Неизвестная комната" });

    const contactId = await upsertContact(tx, name, phone, "birthday_form");
    const created = await tx.query<{ id: string; seq: string }>(
      `INSERT INTO bb.lead_requests (idempotency_key, contact_id, package_id, room_id, requested_date, children, page, referrer, utm_source, utm_medium, utm_campaign, slot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, seq`,
      [input.idempotencyKey, contactId, packageId, roomId, input.date, input.children ?? null, input.page, input.referrer, input.utmSource, input.utmMedium, input.utmCampaign, input.slotId ?? null],
    );
    if (!created.rows[0]) {
      // A parallel request with the same key committed first: return its result, create nothing.
      const winner = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.lead_requests WHERE idempotency_key = $1", [input.idempotencyKey]);
      return { leadId: winner.rows[0].id, seq: Number(winner.rows[0].seq), duplicate: true };
    }
    const leadId = created.rows[0].id;
    await tx.query(
      `INSERT INTO bb.consent_events (contact_id, document_id, event, method, ip_hash, user_agent, lead_request_id)
       VALUES ($1, $2, 'given', 'web_checkbox', $3, $4, $5)`,
      [contactId, consentDoc.id, hashIp(meta.ip, meta.ipPepper), meta.userAgent ? meta.userAgent.slice(0, 400) : null, leadId],
    );
    await tx.query("INSERT INTO bb.outbox (topic, ref_id) VALUES ('telegram.lead', $1)", [leadId]);
    await writeAudit(tx, { actorUserId: null, action: "lead.created", entityType: "lead_request", entityId: leadId });
    return { leadId, seq: Number(created.rows[0].seq), duplicate: false };
  });
}

export interface RegistrationResult {
  registrationId: string;
  seq: number;
  duplicate: boolean;
  documents: Array<{ kind: string; version: number }>;
}

/** Documents the visitor acknowledges / consents to in the QR form. The first two are required, the third is added when published. */
const ACK_KINDS = ["visit_rules", "companion_duties"] as const;

/** QR registration: contact + registration event + one consent event per accepted document version. Not a visit. */
export async function submitConsent(pool: Pool, raw: ConsentInput, meta: IntakeMeta = {}): Promise<RegistrationResult> {
  const parsed = consentSchema.safeParse(raw);
  const errors: Record<string, string> = parsed.success ? {} : fieldErrors(parsed.error);
  const input = parsed.success ? parsed.data : null;
  const phone = input ? normalizePhone(input.phone) : null;
  if (input && !phone) errors.phone = "Проверьте номер телефона";
  if (Object.keys(errors).length || !input || !phone) throw new ValidationError(errors);
  const name = cleanName(input.name);

  return withTx(pool, async (tx) => {
    const existing = await tx.query<{ id: string; seq: string; contact_id: string }>("SELECT id, seq, contact_id FROM bb.consent_registrations WHERE idempotency_key = $1", [input.idempotencyKey]);
    const docsFor = async (registrationId: string) =>
      (await tx.query<{ kind: string; version: number }>(
        "SELECT d.kind::text AS kind, d.version FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id WHERE e.registration_id = $1 ORDER BY d.kind",
        [registrationId],
      )).rows;
    if (existing.rows[0]) {
      return { registrationId: existing.rows[0].id, seq: Number(existing.rows[0].seq), duplicate: true, documents: await docsFor(existing.rows[0].id) };
    }

    const rules = await publishedDoc(tx, "visit_rules");
    const pd = await publishedDoc(tx, "personal_data_consent");
    if (!rules || !pd) throw new ConsentUnavailableError();
    const docs: Array<{ kind: string; id: string }> = [{ kind: "visit_rules", id: rules.id }];
    for (const kind of ACK_KINDS.filter((k) => k !== "visit_rules")) {
      const d = await publishedDoc(tx, kind);
      if (d) docs.push({ kind, id: d.id });
    }
    docs.push({ kind: "personal_data_consent", id: pd.id });

    const contactId = await upsertContact(tx, name, phone, "qr");
    const created = await tx.query<{ id: string; seq: string }>(
      "INSERT INTO bb.consent_registrations (idempotency_key, contact_id) VALUES ($1, $2) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, seq",
      [input.idempotencyKey, contactId],
    );
    if (!created.rows[0]) {
      const winner = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.consent_registrations WHERE idempotency_key = $1", [input.idempotencyKey]);
      return { registrationId: winner.rows[0].id, seq: Number(winner.rows[0].seq), duplicate: true, documents: await docsFor(winner.rows[0].id) };
    }
    const registrationId = created.rows[0].id;
    for (const d of docs) {
      await tx.query(
        `INSERT INTO bb.consent_events (contact_id, document_id, event, method, ip_hash, user_agent, registration_id)
         VALUES ($1, $2, 'given', 'web_checkbox', $3, $4, $5)`,
        [contactId, d.id, hashIp(meta.ip, meta.ipPepper), meta.userAgent ? meta.userAgent.slice(0, 400) : null, registrationId],
      );
    }
    await writeAudit(tx, { actorUserId: null, action: "consent.registered", entityType: "consent_registration", entityId: registrationId });
    return { registrationId, seq: Number(created.rows[0].seq), duplicate: false, documents: await docsFor(registrationId) };
  });
}
