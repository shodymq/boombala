import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";
import type { RequestMeta } from "./users.ts";

export const LEGAL_KINDS = ["privacy_policy", "visit_rules", "companion_duties", "personal_data_consent", "third_party_escort", "group_visits"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export type LegalStatus = "draft" | "approved" | "published" | "retired";

export interface LegalDocument {
  id: string;
  kind: LegalKind;
  version: number;
  title: string;
  body: string;
  status: LegalStatus;
  createdAt: Date;
  approvedAt: Date | null;
  publishedAt: Date | null;
}

const COLS = "id, kind::text AS kind, version, title, body, status::text AS status, created_at, approved_at, published_at";
type Row = { id: string; kind: LegalKind; version: number; title: string; body: string; status: LegalStatus; created_at: Date; approved_at: Date | null; published_at: Date | null };
const map = (r: Row): LegalDocument => ({ id: r.id, kind: r.kind, version: r.version, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, approvedAt: r.approved_at, publishedAt: r.published_at });

export const PLACEHOLDER_MARK = "[ТРЕБУЕТСЯ";
export const hasPlaceholders = (body: string): boolean => body.includes(PLACEHOLDER_MARK);

/** The database refuses placeholder text and illegal changes; this turns that into a readable validation error. */
function mapDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("placeholders")) throw new ValidationError({ body: "В тексте остались пометки [ТРЕБУЕТСЯ …]: заполните их перед утверждением" });
  if (message.includes("cannot be edited")) throw new ConflictError("document_locked");
  if (message.includes("illegal legal document status")) throw new ConflictError("illegal_transition");
  throw error;
}

export async function createDraft(pool: Pool, actor: Actor, input: { kind: LegalKind; title: string; body: string }, meta: RequestMeta = {}): Promise<LegalDocument> {
  assertCan(actor, "legal.manage");
  const errors: Record<string, string> = {};
  if (!(LEGAL_KINDS as readonly string[]).includes(input.kind)) errors.kind = "Неизвестный тип документа";
  if (!input.title.trim() || input.title.length > 200) errors.title = "Укажите название (до 200 символов)";
  if (!input.body.trim() || input.body.length > 100_000) errors.body = "Текст не может быть пустым";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO bb.legal_documents (kind, version, title, body, created_by)
       VALUES ($1, COALESCE((SELECT max(version) FROM bb.legal_documents WHERE kind = $1), 0) + 1, $2, $3, $4)
       RETURNING ${COLS}`,
      [input.kind, input.title.trim(), input.body, actor.id],
    );
    const doc = map(rows[0]);
    await writeAudit(tx, { actorUserId: actor.id, action: "legal.draft_created", entityType: "legal_document", entityId: doc.id, after: { kind: doc.kind, version: doc.version }, ...meta });
    return doc;
  });
}

export async function updateDraft(pool: Pool, actor: Actor, id: string, input: { title: string; body: string }, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "legal.manage");
  if (!input.title.trim() || !input.body.trim()) throw new ValidationError({ body: "Название и текст обязательны" });
  try {
    await withTx(pool, async (tx) => {
      const res = await tx.query("UPDATE bb.legal_documents SET title = $2, body = $3 WHERE id = $1", [id, input.title.trim(), input.body]);
      if (!res.rowCount) throw new ValidationError({ document: "Документ не найден" });
      await writeAudit(tx, { actorUserId: actor.id, action: "legal.draft_updated", entityType: "legal_document", entityId: id, ...meta });
    });
  } catch (error) {
    mapDbError(error);
  }
}

export async function approveDocument(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "legal.manage");
  try {
    await withTx(pool, async (tx) => {
      const res = await tx.query("UPDATE bb.legal_documents SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [id, actor.id]);
      if (!res.rowCount) throw new ValidationError({ document: "Документ не найден" });
      await writeAudit(tx, { actorUserId: actor.id, action: "legal.approved", entityType: "legal_document", entityId: id, ...meta });
    });
  } catch (error) {
    mapDbError(error);
  }
}

/** Publishes an approved version; the previous published version of the same kind is retired in the same transaction. */
export async function publishDocument(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "legal.manage");
  try {
    await withTx(pool, async (tx) => {
      const { rows } = await tx.query<{ kind: string }>("SELECT kind::text AS kind FROM bb.legal_documents WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new ValidationError({ document: "Документ не найден" });
      await tx.query("UPDATE bb.legal_documents SET status = 'retired', retired_at = now() WHERE kind = $1 AND status = 'published'", [rows[0].kind]);
      await tx.query("UPDATE bb.legal_documents SET status = 'published', published_at = now() WHERE id = $1", [id]);
      await writeAudit(tx, { actorUserId: actor.id, action: "legal.published", entityType: "legal_document", entityId: id, after: { kind: rows[0].kind }, ...meta });
    });
  } catch (error) {
    mapDbError(error);
  }
}

export async function retireDocument(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "legal.manage");
  try {
    await withTx(pool, async (tx) => {
      const res = await tx.query("UPDATE bb.legal_documents SET status = 'retired', retired_at = now() WHERE id = $1", [id]);
      if (!res.rowCount) throw new ValidationError({ document: "Документ не найден" });
      await writeAudit(tx, { actorUserId: actor.id, action: "legal.retired", entityType: "legal_document", entityId: id, ...meta });
    });
  } catch (error) {
    mapDbError(error);
  }
}

export async function listDocuments(pool: Pool, actor: Actor): Promise<LegalDocument[]> {
  assertCan(actor, "legal.manage");
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM bb.legal_documents ORDER BY kind, version DESC`);
  return rows.map(map);
}

/** The currently published text of each requested kind (public, no personal data). */
export async function getPublished(db: Queryable, kinds?: readonly LegalKind[]): Promise<LegalDocument[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM bb.legal_documents WHERE status = 'published' AND ($1::text[] IS NULL OR kind::text = ANY($1)) ORDER BY kind`,
    [kinds ? [...kinds] : null],
  );
  return rows.map(map);
}
