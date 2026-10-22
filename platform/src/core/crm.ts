import type { Pool } from "./db.ts";
import { assertCan, type Actor } from "./rbac.ts";

export interface ContactFilters {
  /** Free text: part of the name or of the phone digits. */
  q?: string;
  source?: "qr" | "birthday_form" | "manual";
  verification?: "unverified" | "verified";
  /** Inclusive dates (YYYY-MM-DD, Almaty) for the first registration. */
  from?: string;
  to?: string;
  leadStatus?: "new" | "in_progress" | "confirmed" | "cancelled" | "completed";
}

export interface ContactRow {
  id: string;
  name: string;
  /** null for a QR registration made without a phone. */
  phone: string | null;
  source: string;
  firstRegisteredAt: Date;
  lastActivityAt: Date;
  phoneVerification: string;
  leadsCount: number;
  registrationsCount: number;
  samePhoneOthers: number;
}

const TZ = "Asia/Almaty";

/** Builds the WHERE clause shared by the list and the export (one place, one set of rules). */
export function contactWhere(f: ContactFilters, startAt = 1): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${startAt + params.length - 1}`));
  };
  if (f.q?.trim()) {
    const q = f.q.trim().slice(0, 80);
    const digits = q.replace(/\D/g, "");
    params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    const nameParam = `$${startAt + params.length - 1}`;
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      where.push(`(c.name ILIKE ${nameParam} OR c.phone_e164 LIKE $${startAt + params.length - 1})`);
    } else {
      where.push(`c.name ILIKE ${nameParam}`);
    }
  }
  if (f.source) add("c.source = ?", f.source);
  if (f.verification) add("c.phone_verification = ?", f.verification);
  if (f.from) add(`c.first_registered_at >= (?::date)::timestamp AT TIME ZONE '${TZ}'`, f.from);
  if (f.to) add(`c.first_registered_at < ((?::date) + 1)::timestamp AT TIME ZONE '${TZ}'`, f.to);
  if (f.leadStatus) add("EXISTS (SELECT 1 FROM bb.lead_requests l WHERE l.contact_id = c.id AND l.status = ?)", f.leadStatus);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

const SELECT_CONTACT = `
  SELECT c.id, c.name, c.phone_e164, c.source, c.first_registered_at, c.last_activity_at, c.phone_verification,
         (SELECT count(*) FROM bb.lead_requests l WHERE l.contact_id = c.id)::int AS leads_count,
         (SELECT count(*) FROM bb.consent_registrations r WHERE r.contact_id = c.id)::int AS registrations_count,
         (SELECT count(*) FROM bb.contacts o WHERE c.phone_e164 IS NOT NULL AND o.phone_e164 = c.phone_e164 AND o.id <> c.id)::int AS same_phone_others
    FROM bb.contacts c`;

function mapContact(r: Record<string, never>): ContactRow {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone_e164,
    source: r.source,
    firstRegisteredAt: r.first_registered_at,
    lastActivityAt: r.last_activity_at,
    phoneVerification: r.phone_verification,
    leadsCount: r.leads_count,
    registrationsCount: r.registrations_count,
    samePhoneOthers: r.same_phone_others,
  };
}

export async function listContacts(pool: Pool, actor: Actor, filters: ContactFilters = {}, page = 1, pageSize = 50) {
  assertCan(actor, "contacts.view");
  const size = Math.min(Math.max(pageSize, 1), 200);
  const offset = (Math.max(page, 1) - 1) * size;
  const { sql, params } = contactWhere(filters);
  const [rows, total] = await Promise.all([
    pool.query(`${SELECT_CONTACT} ${sql} ORDER BY c.last_activity_at DESC, c.id LIMIT ${size} OFFSET ${offset}`, params),
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bb.contacts c ${sql}`, params),
  ]);
  return { rows: rows.rows.map(mapContact), total: total.rows[0].n, page: Math.max(page, 1), pageSize: size };
}

export interface ContactCard {
  contact: ContactRow;
  leads: Array<{ id: string; seq: number; createdAt: Date; requestedDate: string; status: string; packageId: string | null; roomId: string | null; children: number | null }>;
  registrations: Array<{ id: string; seq: number; createdAt: Date }>;
  /** `origin`: where the consent event came from (QR registration, an enquiry, or staff action); `enquirySeq` names the enquiry. */
  consents: Array<{ id: number; occurredAt: Date; event: string; method: string; kind: string; version: number; title: string; origin: "qr" | "enquiry" | "staff"; enquirySeq: number | null }>;
  samePhone: Array<{ id: string; name: string }>;
}

export async function getContact(pool: Pool, actor: Actor, id: string): Promise<ContactCard | null> {
  assertCan(actor, "contacts.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const c = await pool.query(`${SELECT_CONTACT} WHERE c.id = $1`, [id]);
  if (!c.rows[0]) return null;
  const contact = mapContact(c.rows[0]);
  const [leads, regs, consents, same] = await Promise.all([
    pool.query(
      `SELECT id, seq, created_at, to_char(requested_date, 'YYYY-MM-DD') AS requested_date, status, package_id, room_id, children
         FROM bb.lead_requests WHERE contact_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
    pool.query("SELECT id, seq, created_at FROM bb.consent_registrations WHERE contact_id = $1 ORDER BY created_at DESC", [id]),
    pool.query(
      `SELECT e.id, e.occurred_at, e.event, e.method, d.kind::text AS kind, d.version, d.title,
              CASE WHEN e.method = 'staff' THEN 'staff' WHEN e.lead_request_id IS NOT NULL THEN 'enquiry' ELSE 'qr' END AS origin, l.seq AS enquiry_seq
         FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
         LEFT JOIN bb.lead_requests l ON l.id = e.lead_request_id
        WHERE e.contact_id = $1 ORDER BY e.occurred_at DESC, e.id DESC`,
      [id],
    ),
    contact.phone ? pool.query("SELECT id, name FROM bb.contacts WHERE phone_e164 = $1 AND id <> $2 ORDER BY name", [contact.phone, id]) : Promise.resolve({ rows: [] as Array<{ id: string; name: string }> }),
  ]);
  return {
    contact,
    leads: leads.rows.map((r) => ({ id: r.id, seq: Number(r.seq), createdAt: r.created_at, requestedDate: r.requested_date, status: r.status, packageId: r.package_id, roomId: r.room_id, children: r.children })),
    registrations: regs.rows.map((r) => ({ id: r.id, seq: Number(r.seq), createdAt: r.created_at })),
    consents: consents.rows.map((r) => ({ id: Number(r.id), occurredAt: r.occurred_at, event: r.event, method: r.method, kind: r.kind, version: r.version, title: r.title, origin: r.origin, enquirySeq: r.enquiry_seq === null ? null : Number(r.enquiry_seq) })),
    samePhone: same.rows,
  };
}
