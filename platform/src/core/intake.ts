import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Client, Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ConsentUnavailableError, DocumentsChangedError, ValidationError } from "./errors.ts";
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
  /** Optional in the QR form (emergency contact). Empty / missing means "no phone"; a filled value must be a valid number. */
  phone: z.string().trim().max(40, "Проверьте номер телефона").optional().nullable(),
  /** How many children come with the adult. Only a number: no names, no birth dates, no ID numbers of children are collected. */
  childrenCount: z.union(
    [z.number().int().min(1, "Укажите от 1 до 50 детей").max(50, "Укажите от 1 до 50 детей"), z.string().trim().regex(/^\d{1,2}$/, "Укажите от 1 до 50 детей").transform(Number).pipe(z.number().int().min(1, "Укажите от 1 до 50 детей").max(50, "Укажите от 1 до 50 детей"))],
    { error: "Укажите от 1 до 50 детей" },
  ),
  /**
   * The editions the visitor was shown, kind -> version. When given, they are compared INSIDE the transaction with the editions
   * that are about to be recorded: a consent is never stored for an edition the visitor did not see.
   */
  documentVersions: z.record(z.string(), z.number().int()).optional(),
  acceptRules: z.literal(true, "Необходимо подтвердить ознакомление с правилами"),
  acceptPersonalData: z.literal(true, "Необходимо согласие на обработку данных"),
});

export type ConsentInput = z.input<typeof consentSchema>;

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}

/**
 * All writes of personal data go through the narrow SECURITY DEFINER functions of migration 012 (`bb.intake_*`): the public
 * API database role has no table privileges on contacts, enquiries, consents, the notification queue or the audit log.
 */
async function upsertContact(tx: Client, name: string, phone: string | null, source: "qr" | "birthday_form"): Promise<string> {
  const { rows } = await tx.query<{ id: string }>("SELECT bb.intake_upsert_contact($1, $2, $3, $4) AS id", [name, nameKey(name), phone, source]);
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
    const existing = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.intake_find_lead($1)", [input.idempotencyKey]);
    if (existing.rows[0]) return { leadId: existing.rows[0].id, seq: Number(existing.rows[0].seq), duplicate: true };

    const consentDoc = await publishedDoc(tx, "personal_data_consent");
    if (!consentDoc) throw new ConsentUnavailableError();
    if (packageId && !(await tx.query("SELECT 1 FROM bb.packages WHERE id = $1 AND is_active", [packageId])).rowCount) throw new ValidationError({ packageId: "Неизвестный пакет" });
    if (roomId && !(await tx.query("SELECT 1 FROM bb.rooms WHERE id = $1 AND is_active", [roomId])).rowCount) throw new ValidationError({ roomId: "Неизвестная комната" });

    const contactId = await upsertContact(tx, name, phone, "birthday_form");
    const created = await tx.query<{ id: string; seq: string }>(
      "SELECT id, seq FROM bb.intake_insert_lead($1, $2, $3, $4, $5::date, $6::smallint, $7, $8, $9, $10, $11, $12::smallint)",
      [input.idempotencyKey, contactId, packageId, roomId, input.date, input.children ?? null, input.page, input.referrer, input.utmSource, input.utmMedium, input.utmCampaign, input.slotId ?? null],
    );
    if (!created.rows[0]) {
      // A parallel request with the same key committed first: return its result, create nothing.
      const winner = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.intake_find_lead($1)", [input.idempotencyKey]);
      return { leadId: winner.rows[0].id, seq: Number(winner.rows[0].seq), duplicate: true };
    }
    const leadId = created.rows[0].id;
    await tx.query("SELECT bb.intake_add_consent($1, $2, $3, $4, $5, NULL)", [contactId, consentDoc.id, hashIp(meta.ip, meta.ipPepper), meta.userAgent ? meta.userAgent.slice(0, 400) : null, leadId]);
    await tx.query("SELECT bb.intake_queue_notification($1)", [leadId]);
    await tx.query("SELECT bb.intake_audit('lead.created', 'lead_request', $1)", [leadId]);
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
  const rawPhone = input?.phone?.trim() ?? "";
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (input && rawPhone && !phone) errors.phone = "Проверьте номер телефона";
  if (Object.keys(errors).length || !input) throw new ValidationError(errors);
  const name = cleanName(input.name);

  return withTx(pool, async (tx) => {
    // Parallel sends of one key are served one after another: without this the losers would each create a phoneless
    // contact (nothing merges them) before finding out they lost. Transaction-level lock: safe through a pooler.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`consent:${input.idempotencyKey}`]);
    const existing = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.intake_find_registration($1)", [input.idempotencyKey]);
    const docsFor = async (registrationId: string) => (await tx.query<{ kind: string; version: number }>("SELECT kind, version FROM bb.intake_registration_documents($1)", [registrationId])).rows;
    if (existing.rows[0]) {
      return { registrationId: existing.rows[0].id, seq: Number(existing.rows[0].seq), duplicate: true, documents: await docsFor(existing.rows[0].id) };
    }

    const rules = await publishedDoc(tx, "visit_rules");
    const pd = await publishedDoc(tx, "personal_data_consent");
    if (!rules || !pd) throw new ConsentUnavailableError();
    const docs: Array<{ kind: string; id: string; version: number }> = [{ kind: "visit_rules", id: rules.id, version: rules.version }];
    for (const kind of ACK_KINDS.filter((k) => k !== "visit_rules")) {
      const d = await publishedDoc(tx, kind);
      if (d) docs.push({ kind, id: d.id, version: d.version });
    }
    docs.push({ kind: "personal_data_consent", id: pd.id, version: pd.version });
    // The check and the writes below are ONE transaction on these very rows: the consent is recorded against exactly the editions compared here,
    // and intake_add_consent re-checks that each is still published at the moment of writing (a publish in between fails the whole submission).
    if (input.documentVersions) {
      const shown = input.documentVersions;
      if (Object.keys(shown).length !== docs.length || docs.some((d) => shown[d.kind] !== d.version)) throw new DocumentsChangedError();
    }

    const contactId = await upsertContact(tx, name, phone, "qr");
    const created = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.intake_insert_registration($1, $2, $3::smallint)", [input.idempotencyKey, contactId, input.childrenCount]);
    if (!created.rows[0]) {
      const winner = await tx.query<{ id: string; seq: string }>("SELECT id, seq FROM bb.intake_find_registration($1)", [input.idempotencyKey]);
      return { registrationId: winner.rows[0].id, seq: Number(winner.rows[0].seq), duplicate: true, documents: await docsFor(winner.rows[0].id) };
    }
    const registrationId = created.rows[0].id;
    for (const d of docs) {
      try {
        await tx.query("SELECT bb.intake_add_consent($1, $2, $3, $4, NULL, $5)", [contactId, d.id, hashIp(meta.ip, meta.ipPepper), meta.userAgent ? meta.userAgent.slice(0, 400) : null, registrationId]);
      } catch (error) {
        // the edition was withdrawn between reading and writing: nothing of this submission is kept
        if ((error as { code?: string }).code === "22023" && /not published/.test((error as Error).message)) throw new DocumentsChangedError();
        throw error;
      }
    }
    await tx.query("SELECT bb.intake_audit('consent.registered', 'consent_registration', $1)", [registrationId]);
    return { registrationId, seq: Number(created.rows[0].seq), duplicate: false, documents: await docsFor(registrationId) };
  });
}
