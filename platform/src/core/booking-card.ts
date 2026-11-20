import type { Client, Queryable } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import {
  computePricing,
  OPTION_KINDS,
  remainingFor,
  validateSelections,
  type OptionKind,
  type PackageTerms,
  type PricingResult,
  type Selection,
} from "./booking-pricing.ts";

/**
 * The booking card (Booking V2): everything a manager records about one event, kept apart from the immutable reservation so
 * it can be edited without recreating the booking and follows the event when it is moved. All writes take a transaction
 * client; the caller (the typed bridge) owns idempotency and the permission check. Nothing here trusts a client price.
 */

export type HeadcountMode = "exact" | "by_fact";
export type ProgramStatus = "draft" | "approved";
export type PropsStatus = "not_started" | "preparing" | "ready";
export type InvitationStatus = "not_applicable" | "not_started" | "in_progress" | "sent";
export interface ServiceLine {
  name: string;
  amountKzt: number;
}

export interface CardFields {
  preferredLanguage: "ru" | "kk" | null;
  childName: string | null;
  childAge: number | null;
  headcountMode: HeadcountMode;
  childrenTotal: number | null;
  adultsTotal: number | null;
  animators: string[];
  responsibleUserId: string | null;
  animationNote: string | null;
  wishes: string | null;
  decoration: string | null;
  cake: string | null;
  staffComment: string | null;
  programStatus: ProgramStatus;
  propsStatus: PropsStatus;
  invitationStatus: InvitationStatus;
  manualExtraChildrenKzt: number | null;
  manualExtraAdultsKzt: number | null;
  services: ServiceLine[];
  mealKzt: number;
  selections: Selection[];
}

export type CardPatch = Partial<CardFields>;

const LANGS = ["ru", "kk"];
const HEADCOUNT = ["exact", "by_fact"];
const PROGRAM = ["draft", "approved"];
const PROPS = ["not_started", "preparing", "ready"];
const INVITATION = ["not_applicable", "not_started", "in_progress", "sent"];

function str(value: unknown, field: string, max: number, errors: Record<string, string>): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    errors[field] = "Некорректное значение";
    return undefined;
  }
  const v = value.trim();
  if (v.length > max) {
    errors[field] = `Не больше ${max} символов`;
    return undefined;
  }
  return v === "" ? null : v;
}

function int(value: unknown, field: string, min: number, max: number, errors: Record<string, string>): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    errors[field] = `От ${min} до ${max}`;
    return undefined;
  }
  return n;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly string[], errors: Record<string, string>): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors[field] = "Недопустимое значение";
    return undefined;
  }
  return value as T;
}

/** Validates untrusted input into a patch. Throws ValidationError with a message per field. Unknown keys are ignored. */
export function parseCardPatch(input: unknown): CardPatch {
  const errors: Record<string, string> = {};
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const patch: CardPatch = {};
  const set = <K extends keyof CardFields>(key: K, value: CardFields[K] | undefined) => {
    if (value !== undefined) patch[key] = value;
  };

  const lang = src.preferredLanguage === null ? null : oneOf<"ru" | "kk">(src.preferredLanguage, "preferredLanguage", LANGS, errors);
  if (src.preferredLanguage === null) patch.preferredLanguage = null;
  else set("preferredLanguage", lang);
  set("childName", str(src.childName, "childName", 80, errors));
  set("childAge", int(src.childAge, "childAge", 0, 99, errors));
  set("headcountMode", oneOf<HeadcountMode>(src.headcountMode, "headcountMode", HEADCOUNT, errors));
  set("childrenTotal", int(src.childrenTotal, "childrenTotal", 0, 200, errors));
  set("adultsTotal", int(src.adultsTotal, "adultsTotal", 0, 200, errors));
  set("responsibleUserId", str(src.responsibleUserId, "responsibleUserId", 64, errors));
  set("animationNote", str(src.animationNote, "animationNote", 300, errors));
  set("wishes", str(src.wishes, "wishes", 1000, errors));
  set("decoration", str(src.decoration, "decoration", 300, errors));
  set("cake", str(src.cake, "cake", 300, errors));
  set("staffComment", str(src.staffComment, "staffComment", 1000, errors));
  set("programStatus", oneOf<ProgramStatus>(src.programStatus, "programStatus", PROGRAM, errors));
  set("propsStatus", oneOf<PropsStatus>(src.propsStatus, "propsStatus", PROPS, errors));
  set("invitationStatus", oneOf<InvitationStatus>(src.invitationStatus, "invitationStatus", INVITATION, errors));
  set("manualExtraChildrenKzt", int(src.manualExtraChildrenKzt, "manualExtraChildrenKzt", 0, 10_000_000, errors));
  set("manualExtraAdultsKzt", int(src.manualExtraAdultsKzt, "manualExtraAdultsKzt", 0, 10_000_000, errors));
  const meal = int(src.mealKzt, "mealKzt", 0, 10_000_000, errors);
  if (meal !== undefined) patch.mealKzt = meal ?? 0;

  if (src.animators !== undefined) {
    if (!Array.isArray(src.animators) || src.animators.length > 10 || src.animators.some((a) => typeof a !== "string" || a.trim().length < 1 || a.trim().length > 60)) {
      errors.animators = "Не более 10 имён, каждое до 60 символов";
    } else patch.animators = src.animators.map((a: string) => a.trim());
  }
  if (src.services !== undefined) {
    const list = src.services;
    const ok =
      Array.isArray(list) &&
      list.length <= 30 &&
      list.every((s) => s && typeof s === "object" && typeof s.name === "string" && s.name.trim().length >= 1 && s.name.trim().length <= 80 && Number.isInteger(s.amountKzt) && s.amountKzt >= 1 && s.amountKzt <= 10_000_000);
    if (!ok) errors.services = "Услуга: название до 80 символов и сумма в тенге";
    else patch.services = (list as ServiceLine[]).map((s) => ({ name: s.name.trim(), amountKzt: s.amountKzt }));
  }
  if (src.selections !== undefined) {
    const list = src.selections;
    const ok = Array.isArray(list) && list.length <= 20 && list.every((s) => s && typeof s === "object" && (OPTION_KINDS as readonly string[]).includes(s.kind) && typeof s.optionId === "string" && /^[a-z0-9-]{1,60}$/.test(s.optionId));
    if (!ok) errors.selections = "Некорректный выбор программы";
    else patch.selections = (list as Selection[]).map((s) => ({ kind: s.kind, optionId: s.optionId }));
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return patch;
}

// ── Catalog reads ──────────────────────────────────────────────────────────────────────────────────────────────

export async function loadTerms(db: Queryable, packageId: string, version?: string | null): Promise<PackageTerms | null> {
  const head = await db.query<{
    package_id: string; version: string; included_children: number; included_adults: number; animators: number; program_minutes: number;
    room_minutes: number; extra_child_discount_pct: number; cake_ceremony: boolean; online_invitation: boolean;
  }>(
    `SELECT package_id, version, included_children, included_adults, animators, program_minutes, room_minutes, extra_child_discount_pct, cake_ceremony, online_invitation
       FROM bb.package_versions WHERE package_id = $1 AND ($2::text IS NULL AND is_current OR version = $2)`,
    [packageId, version ?? null],
  );
  const h = head.rows[0];
  if (!h) return null;
  const [rules, options] = await Promise.all([
    db.query<{ kind: OptionKind; pick_count: number; minutes: number }>("SELECT kind, pick_count, minutes FROM bb.package_program_rules WHERE package_id = $1 AND version = $2 ORDER BY kind", [packageId, h.version]),
    db.query<{ kind: OptionKind; option_id: string }>(
      `SELECT o.kind, o.option_id FROM bb.package_program_options o JOIN bb.program_options p ON p.id = o.option_id
        WHERE o.package_id = $1 AND o.version = $2 ORDER BY p.sort_order, o.option_id`,
      [packageId, h.version],
    ),
  ]);
  return {
    packageId: h.package_id,
    version: h.version,
    includedChildren: h.included_children,
    includedAdults: h.included_adults,
    animators: h.animators,
    programMinutes: h.program_minutes,
    roomMinutes: h.room_minutes,
    extraChildDiscountPct: h.extra_child_discount_pct,
    cakeCeremony: h.cake_ceremony,
    onlineInvitation: h.online_invitation,
    rules: rules.rows.map((r) => ({ kind: r.kind, pickCount: r.pick_count, minutes: r.minutes, options: options.rows.filter((o) => o.kind === r.kind).map((o) => o.option_id) })),
  };
}

export interface OptionName {
  id: string;
  kind: OptionKind;
  nameRu: string;
  nameKk: string;
}

export async function listOptionNames(db: Queryable): Promise<OptionName[]> {
  const { rows } = await db.query<{ id: string; kind: OptionKind; name_ru: string; name_kk: string }>("SELECT id, kind, name_ru, name_kk FROM bb.program_options ORDER BY kind, sort_order, id");
  return rows.map((r) => ({ id: r.id, kind: r.kind, nameRu: r.name_ru, nameKk: r.name_kk }));
}

async function tariffFor(db: Queryable, kind: "child" | "adult", onDate: string): Promise<number | null> {
  const { rows } = await db.query<{ amount_kzt: number }>("SELECT amount_kzt FROM bb.guest_tariffs WHERE kind = $1 AND valid_from <= $2::date ORDER BY valid_from DESC, id DESC LIMIT 1", [kind, onDate]);
  return rows[0]?.amount_kzt ?? null;
}

// ── Card rows ──────────────────────────────────────────────────────────────────────────────────────────────────

interface CardRow {
  id: string;
  reservation_id: string;
  lead_request_id: string | null;
  package_id: string | null;
  terms_version: string | null;
  preferred_language: "ru" | "kk" | null;
  child_name: string | null;
  child_age: number | null;
  headcount_mode: HeadcountMode;
  children_total: number | null;
  adults_total: number | null;
  animators: string[];
  selections: Selection[];
  responsible_user_id: string | null;
  animation_note: string | null;
  wishes: string | null;
  decoration: string | null;
  cake: string | null;
  staff_comment: string | null;
  program_status: ProgramStatus;
  props_status: PropsStatus;
  invitation_status: InvitationStatus;
  base_price_kzt: number | null;
  extra_children_kzt: number | null;
  extra_adults_kzt: number | null;
  manual_extra_children_kzt: number | null;
  manual_extra_adults_kzt: number | null;
  services: ServiceLine[];
  services_kzt: number;
  meal_kzt: number;
  pricing_status: "complete" | "incomplete";
  pricing_gaps: string[];
  total_kzt: number | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
}

interface ReservationRow {
  id: string;
  kind: "booking" | "block";
  slot_date: string;
  room_id: string;
  starts_at: Date;
  lead_request_id: string | null;
  contact_id: string | null;
  package_id: string | null;
  children: number | null;
  price_kzt: number | null;
  price_source: string | null;
  created_by: string;
  released_at: Date | null;
  contact_name: string | null;
  contact_phone: string | null;
}

async function loadReservation(db: Queryable, reservationId: string, lock = false): Promise<ReservationRow | null> {
  const { rows } = await db.query<ReservationRow>(
    `SELECT r.id, r.kind, to_char(r.slot_date, 'YYYY-MM-DD') AS slot_date, r.room_id, r.starts_at, r.lead_request_id, r.contact_id, r.package_id,
            r.children, r.price_kzt, r.price_source, r.created_by, r.released_at, c.name AS contact_name, c.phone_e164 AS contact_phone
       FROM bb.slot_reservations r LEFT JOIN bb.contacts c ON c.id = r.contact_id WHERE r.id = $1 ${lock ? "FOR UPDATE OF r" : ""}`,
    [reservationId],
  );
  return rows[0] ?? null;
}

async function loadCardRow(db: Queryable, reservationId: string, lock = false): Promise<CardRow | null> {
  const { rows } = await db.query<CardRow>(`SELECT * FROM bb.booking_cards WHERE reservation_id = $1 ${lock ? "FOR UPDATE" : ""}`, [reservationId]);
  return rows[0] ?? null;
}

function fieldsOf(row: CardRow): CardFields {
  return {
    preferredLanguage: row.preferred_language,
    childName: row.child_name,
    childAge: row.child_age,
    headcountMode: row.headcount_mode,
    childrenTotal: row.children_total,
    adultsTotal: row.adults_total,
    animators: row.animators,
    responsibleUserId: row.responsible_user_id,
    animationNote: row.animation_note,
    wishes: row.wishes,
    decoration: row.decoration,
    cake: row.cake,
    staffComment: row.staff_comment,
    programStatus: row.program_status,
    propsStatus: row.props_status,
    invitationStatus: row.invitation_status,
    manualExtraChildrenKzt: row.manual_extra_children_kzt,
    manualExtraAdultsKzt: row.manual_extra_adults_kzt,
    services: row.services,
    mealKzt: row.meal_kzt,
    selections: row.selections,
  };
}

function emptyFields(res: ReservationRow, terms: PackageTerms | null): CardFields {
  return {
    preferredLanguage: null,
    childName: null,
    childAge: null,
    headcountMode: "exact",
    childrenTotal: res.children,
    adultsTotal: null,
    animators: [],
    responsibleUserId: res.created_by,
    animationNote: null,
    wishes: null,
    decoration: null,
    cake: null,
    staffComment: null,
    programStatus: "draft",
    propsStatus: "not_started",
    invitationStatus: terms?.onlineInvitation ? "not_started" : "not_applicable",
    manualExtraChildrenKzt: null,
    manualExtraAdultsKzt: null,
    services: [],
    mealKzt: 0,
    selections: [],
  };
}

async function price(db: Queryable, res: ReservationRow, terms: PackageTerms | null, f: CardFields): Promise<PricingResult> {
  const [childTariff, adultTariff] = await Promise.all([tariffFor(db, "child", res.slot_date), tariffFor(db, "adult", res.slot_date)]);
  return computePricing({
    basePriceKzt: res.kind === "booking" ? res.price_kzt : null,
    terms,
    headcountMode: f.headcountMode,
    childrenTotal: f.childrenTotal,
    adultsTotal: f.adultsTotal,
    childTariffKzt: childTariff,
    adultTariffKzt: adultTariff,
    manualExtraChildrenKzt: f.manualExtraChildrenKzt,
    manualExtraAdultsKzt: f.manualExtraAdultsKzt,
    servicesKzt: f.services.reduce((s, x) => s + x.amountKzt, 0),
    mealKzt: f.mealKzt,
  });
}

async function writeEvent(tx: Client, cardId: string, reservationId: string, actorId: string, action: string, changes: unknown): Promise<void> {
  await tx.query("INSERT INTO bb.booking_card_events (card_id, reservation_id, actor_user_id, action, changes) VALUES ($1,$2,$3,$4,$5::jsonb)", [cardId, reservationId, actorId, action, JSON.stringify(changes ?? {})]);
}

async function assertResponsible(db: Queryable, userId: string): Promise<void> {
  const { rows } = await db.query("SELECT 1 FROM bb.users WHERE id = $1 AND is_active AND role IN ('owner', 'manager')", [userId]);
  if (!rows[0]) throw new ValidationError({ responsibleUserId: "Ответственным может быть активный менеджер или владелец" });
}

/** Whether `value` is a canonical UUID (the database would reject anything else with a 22P02 instead of a field error). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_COLUMNS: Record<string, string> = {
  preferredLanguage: "preferred_language", childName: "child_name", childAge: "child_age", headcountMode: "headcount_mode",
  childrenTotal: "children_total", adultsTotal: "adults_total", responsibleUserId: "responsible_user_id", animationNote: "animation_note",
  wishes: "wishes", decoration: "decoration", cake: "cake", staffComment: "staff_comment", programStatus: "program_status",
  propsStatus: "props_status", invitationStatus: "invitation_status", manualExtraChildrenKzt: "manual_extra_children_kzt",
  manualExtraAdultsKzt: "manual_extra_adults_kzt", mealKzt: "meal_kzt",
};

// ── Creation ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Creates the card of a reservation (at confirmation, or lazily for an older reservation). The package terms version is the
 * one current NOW and is recorded, so a later catalog update never changes how this booking is read. Idempotent per reservation.
 */
export async function ensureCard(tx: Client, actorId: string, reservationId: string, patch: CardPatch = {}): Promise<CardRow> {
  const existing = await loadCardRow(tx, reservationId, true);
  if (existing) return existing;
  const res = await loadReservation(tx, reservationId);
  if (!res) throw new NotFoundError();
  const terms = res.package_id ? await loadTerms(tx, res.package_id) : null;
  const base = emptyFields(res, terms);
  const merged = { ...base, ...patch } as CardFields;
  if (merged.responsibleUserId) await assertResponsible(tx, merged.responsibleUserId);
  if (merged.selections.length) {
    if (!terms) throw new ValidationError({ selections: "У события нет пакета" });
    const errors = validateSelections(terms, merged.selections, false);
    if (Object.keys(errors).length) throw new ValidationError(errors);
  }
  if (merged.invitationStatus !== "not_applicable" && !terms?.onlineInvitation) merged.invitationStatus = "not_applicable";
  const pricing = await price(tx, res, terms, merged);
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO bb.booking_cards (reservation_id, lead_request_id, package_id, terms_version, preferred_language, child_name, child_age, headcount_mode,
        children_total, adults_total, animators, selections, responsible_user_id, animation_note, wishes, decoration, cake, staff_comment, program_status,
        props_status, invitation_status, base_price_kzt, extra_children_kzt, extra_adults_kzt, manual_extra_children_kzt, manual_extra_adults_kzt,
        services, services_kzt, meal_kzt, pricing_status, pricing_gaps, total_kzt, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,'draft',$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28,$29,$30::jsonb,$31,$32,$32)
     RETURNING id`,
    [
      reservationId, res.lead_request_id, res.package_id, terms?.version ?? null, merged.preferredLanguage, merged.childName, merged.childAge, merged.headcountMode,
      merged.childrenTotal, merged.adultsTotal, JSON.stringify(merged.animators), JSON.stringify(merged.selections), merged.responsibleUserId, merged.animationNote,
      merged.wishes, merged.decoration, merged.cake, merged.staffComment, merged.propsStatus, merged.invitationStatus, res.kind === "booking" ? res.price_kzt : null,
      pricing.extraChildrenKzt, pricing.extraAdultsKzt, merged.manualExtraChildrenKzt, merged.manualExtraAdultsKzt, JSON.stringify(merged.services), pricing.servicesKzt,
      merged.mealKzt, pricing.status, JSON.stringify(pricing.gaps), pricing.totalKzt, actorId,
    ],
  );
  const cardId = inserted.rows[0].id;
  await writeEvent(tx, cardId, reservationId, actorId, "created", { package: res.package_id, termsVersion: terms?.version ?? null, basePriceKzt: res.price_kzt });
  if (res.lead_request_id) {
    const paid = await tx.query<{ amount_kzt: number; payment_method: string }>("SELECT amount_kzt, payment_method FROM bb.manual_payment_facts WHERE lead_request_id = $1", [res.lead_request_id]);
    if (paid.rows[0]) await writeEvent(tx, cardId, reservationId, actorId, "prepayment_recorded", { amountKzt: paid.rows[0].amount_kzt, method: paid.rows[0].payment_method });
  }
  return (await loadCardRow(tx, reservationId))!;
}

// ── Editing ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SaveResult {
  version: number;
  programStatus: ProgramStatus;
  pricingStatus: "complete" | "incomplete";
  totalKzt: number | null;
  changed: string[];
}

/**
 * Saves a patch of the card. Optimistic concurrency: `expectedVersion` is the version the editor loaded (null for a card that
 * did not exist yet); another manager's save in between makes this one fail with `card_version_conflict` instead of silently
 * overwriting. Returns what changed. The original creator is never touched; the author of this change is recorded.
 */
export async function saveCard(tx: Client, actorId: string, reservationId: string, expectedVersion: number | null, patch: CardPatch, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<SaveResult> {
  const res = await loadReservation(tx, reservationId, true);
  if (!res) throw new NotFoundError();
  if (res.released_at) throw new ConflictError("reservation_already_released");
  const existing = await loadCardRow(tx, reservationId, true);
  if (!existing && expectedVersion !== null) throw new ConflictError("card_version_conflict");
  if (existing && expectedVersion !== existing.version) throw new ConflictError("card_version_conflict");
  const terms = res.package_id ? await loadTerms(tx, res.package_id, existing?.terms_version) : null;

  const card = existing ?? (await ensureCard(tx, actorId, reservationId));
  const before = fieldsOf(card);
  const next: CardFields = { ...before, ...patch };

  const errors: Record<string, string> = {};
  if (patch.responsibleUserId !== undefined && patch.responsibleUserId !== null) {
    if (!UUID.test(patch.responsibleUserId)) errors.responsibleUserId = "Недопустимое значение";
    else await assertResponsible(tx, patch.responsibleUserId);
  }
  if (patch.invitationStatus !== undefined && patch.invitationStatus !== "not_applicable" && !terms?.onlineInvitation) errors.invitationStatus = "Онлайн-приглашение входит только в Boom Bala Party";
  if (patch.invitationStatus === "not_applicable" && terms?.onlineInvitation) errors.invitationStatus = "Для этого пакета приглашение применимо";
  if (patch.selections !== undefined) {
    if (!terms) errors.selections = "У события нет пакета, выбор программы недоступен";
    else Object.assign(errors, validateSelections(terms, next.selections, false));
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  // Program approval is checked against the package on the server. Editing the choice of an approved program reopens it.
  let programEvent: "program_approved" | "program_reopened" | null = null;
  const selectionsChanged = patch.selections !== undefined && JSON.stringify(sortSel(before.selections)) !== JSON.stringify(sortSel(next.selections));
  if (patch.programStatus === "approved" && (before.programStatus !== "approved" || selectionsChanged)) {
    if (!terms) throw new ValidationError({ programStatus: "У события нет пакета" });
    const approvalErrors = validateSelections(terms, next.selections, true);
    if (Object.keys(approvalErrors).length) throw new ValidationError({ ...approvalErrors, programStatus: "Программа заполнена не полностью" });
    next.programStatus = "approved";
    programEvent = "program_approved";
  } else if (before.programStatus === "approved" && (patch.programStatus === "draft" || selectionsChanged)) {
    next.programStatus = "draft";
    programEvent = "program_reopened";
  }

  const pricing = await price(tx, res, terms, next);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const compare = (key: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  };
  for (const key of Object.keys(FIELD_COLUMNS)) compare(key, (before as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key]);
  compare("animators", before.animators, next.animators);
  compare("services", before.services, next.services);
  compare("selections", sortSel(before.selections), sortSel(next.selections));
  compare("totalKzt", card.total_kzt, pricing.totalKzt);

  if (Object.keys(changes).length === 0 && !programEvent) {
    return { version: card.version, programStatus: card.program_status, pricingStatus: card.pricing_status, totalKzt: card.total_kzt, changed: [] };
  }

  await tx.query(
    `UPDATE bb.booking_cards SET preferred_language=$2, child_name=$3, child_age=$4, headcount_mode=$5, children_total=$6, adults_total=$7, animators=$8::jsonb,
            responsible_user_id=$9, animation_note=$10, wishes=$11, decoration=$12, cake=$13, staff_comment=$14, program_status=$15, props_status=$16,
            invitation_status=$17, extra_children_kzt=$18, extra_adults_kzt=$19, manual_extra_children_kzt=$20, manual_extra_adults_kzt=$21, services=$22::jsonb,
            services_kzt=$23, meal_kzt=$24, pricing_status=$25, pricing_gaps=$26::jsonb, total_kzt=$27, version=version+1, updated_by=$28, updated_at=now(),
            selections=$29::jsonb
      WHERE id=$1`,
    [
      card.id, next.preferredLanguage, next.childName, next.childAge, next.headcountMode, next.childrenTotal, next.adultsTotal, JSON.stringify(next.animators),
      next.responsibleUserId, next.animationNote, next.wishes, next.decoration, next.cake, next.staffComment, next.programStatus, next.propsStatus,
      next.invitationStatus, pricing.extraChildrenKzt, pricing.extraAdultsKzt, next.manualExtraChildrenKzt, next.manualExtraAdultsKzt, JSON.stringify(next.services),
      pricing.servicesKzt, next.mealKzt, pricing.status, JSON.stringify(pricing.gaps), pricing.totalKzt, actorId, JSON.stringify(sortSel(next.selections)),
    ],
  );
  const edited = Object.keys(changes).filter((k) => k !== "programStatus" && k !== "totalKzt");
  if (edited.length || (changes.totalKzt && !programEvent)) await writeEvent(tx, card.id, reservationId, actorId, "updated", changes);
  if (programEvent) await writeEvent(tx, card.id, reservationId, actorId, programEvent, { selections: sortSel(next.selections) });
  await writeAudit(tx, { actorUserId: actorId, action: "booking.card_updated", entityType: "slot_reservation", entityId: reservationId, after: { fields: Object.keys(changes), programEvent }, ...meta });
  return { version: card.version + 1, programStatus: next.programStatus, pricingStatus: pricing.status, totalKzt: pricing.totalKzt, changed: Object.keys(changes) };
}

function sortSel(list: Selection[]): Selection[] {
  return [...list].sort((a, b) => (a.kind + a.optionId).localeCompare(b.kind + b.optionId));
}

// ── Hooks used by the booking writers ──────────────────────────────────────────────────────────────────────────

/** A move releases the reservation and writes a new one. The card follows the event and keeps its creator. */
export async function followReschedule(tx: Client, actorId: string, oldId: string, newId: string, move: { from: unknown; to: unknown }): Promise<void> {
  const card = await loadCardRow(tx, oldId, true);
  if (!card) return;
  await tx.query("UPDATE bb.booking_cards SET reservation_id = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [card.id, newId, actorId]);
  await writeEvent(tx, card.id, newId, actorId, "rescheduled", move);
}

export async function recordCancellation(tx: Client, actorId: string, reservationId: string, reason: string | null): Promise<void> {
  const card = await loadCardRow(tx, reservationId, true);
  if (!card) return;
  await writeEvent(tx, card.id, reservationId, actorId, "cancelled", { reason });
}

/** The prepayment is a fact on the request. When the event already has a card the history shows when it was recorded. */
export async function recordPrepayment(tx: Client, actorId: string, leadRequestId: string, fact: { amountKzt: number; method: string }): Promise<void> {
  const { rows } = await tx.query<{ id: string; reservation_id: string }>("SELECT id, reservation_id FROM bb.booking_cards WHERE lead_request_id = $1", [leadRequestId]);
  if (!rows[0]) return;
  await writeEvent(tx, rows[0].id, rows[0].reservation_id, actorId, "prepayment_recorded", fact);
}

// ── Read view ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: number;
  at: string;
  action: string;
  actorName: string | null;
  changes: Record<string, unknown>;
}

export interface BookingCardView {
  /** False for an older reservation that has no card yet: the values are defaults and nothing is stored until the first save. */
  exists: boolean;
  reservationId: string;
  kind: "booking" | "block";
  released: boolean;
  version: number | null;
  packageId: string | null;
  termsVersion: string | null;
  fields: CardFields;
  terms: PackageTerms | null;
  optionNames: OptionName[];
  pricing: PricingResult;
  baseSource: string | null;
  paidKzt: number;
  remainingKzt: number | null;
  createdByName: string | null;
  responsibleName: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  history: HistoryEntry[];
  customer: { name: string | null; phone: string | null };
  eventDate: string;
}

export async function getCardView(db: Queryable, reservationId: string): Promise<BookingCardView> {
  const res = await loadReservation(db, reservationId);
  if (!res) throw new NotFoundError();
  const row = await loadCardRow(db, reservationId);
  const terms = res.package_id ? await loadTerms(db, res.package_id, row?.terms_version) : null;
  const fields = row ? fieldsOf(row) : emptyFields(res, terms);
  const pricing = await price(db, res, terms, fields);
  const [paid, names, history, people] = await Promise.all([
    res.lead_request_id ? db.query<{ amount_kzt: number }>("SELECT amount_kzt FROM bb.manual_payment_facts WHERE lead_request_id = $1", [res.lead_request_id]) : Promise.resolve({ rows: [] as { amount_kzt: number }[] }),
    listOptionNames(db),
    row
      ? db.query<{ id: string; created_at: Date; action: string; changes: Record<string, unknown>; name: string | null }>(
          `SELECT e.id, e.created_at, e.action, e.changes, u.name FROM bb.booking_card_events e LEFT JOIN bb.users u ON u.id = e.actor_user_id WHERE e.card_id = $1 ORDER BY e.id DESC LIMIT 100`,
          [row.id],
        )
      : Promise.resolve({ rows: [] as { id: string; created_at: Date; action: string; changes: Record<string, unknown>; name: string | null }[] }),
    db.query<{ id: string; name: string }>("SELECT id, name FROM bb.users WHERE id = ANY($1::uuid[])", [[row?.created_by ?? res.created_by, fields.responsibleUserId, row?.updated_by].filter((x): x is string => typeof x === "string")]),
  ]);
  const name = (id: string | null | undefined) => (id ? people.rows.find((p) => p.id === id)?.name ?? null : null);
  const paidKzt = paid.rows[0]?.amount_kzt ?? 0;
  return {
    exists: Boolean(row),
    reservationId,
    kind: res.kind,
    released: res.released_at !== null,
    version: row?.version ?? null,
    packageId: res.package_id,
    termsVersion: row?.terms_version ?? terms?.version ?? null,
    fields,
    terms,
    optionNames: names,
    pricing,
    baseSource: res.price_source,
    paidKzt,
    remainingKzt: remainingFor(pricing.totalKzt, paidKzt),
    createdByName: name(row?.created_by ?? res.created_by),
    responsibleName: name(fields.responsibleUserId),
    updatedByName: name(row?.updated_by),
    updatedAt: row?.updated_at.toISOString() ?? null,
    history: history.rows.map((h) => ({ id: Number(h.id), at: h.created_at.toISOString(), action: h.action, actorName: h.name, changes: h.changes })),
    customer: { name: res.contact_name, phone: res.contact_phone },
    eventDate: res.slot_date,
  };
}

// ── Handover of a Google Sheets record to the CRM ──────────────────────────────────────────────────────────────

function digits(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,3})\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * From now on the CRM manages the record: sync ignores its sheet row (it no longer moves or releases the reservation) and the
 * CRM may edit, move and cancel it. The card is prefilled from what the sheet held, so nothing typed there is lost. The
 * prepayment written in the sheet stays what it was: a note, not a confirmed payment.
 */
export async function handoverSheetRecord(tx: Client, actorId: string, reservationId: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ cardId: string }> {
  const res = await loadReservation(tx, reservationId, true);
  if (!res) throw new NotFoundError();
  if (res.released_at) throw new ConflictError("reservation_already_released");
  const rec = await tx.query<{ source_key: string; state: string; source_payload: Record<string, string>; source_row_number: number | null }>(
    "SELECT source_key, state, source_payload, source_row_number FROM bb.sheet_sync_records WHERE reservation_id = $1 FOR UPDATE",
    [reservationId],
  );
  const record = rec.rows[0];
  if (!record) throw new ConflictError("not_sheet_managed");
  if (record.state === "crm_managed") throw new ConflictError("already_handed_over");
  const payload = record.source_payload ?? {};
  const age = digits(payload.age);
  const prefill: CardPatch = {
    childName: typeof payload.child === "string" && payload.child.trim() ? payload.child.trim().slice(0, 80) : null,
    childAge: age !== null && age <= 99 ? age : null,
    childrenTotal: digits(payload.children),
    adultsTotal: digits(payload.adults),
    animators: typeof payload.animator === "string" && payload.animator.trim() ? [payload.animator.trim().slice(0, 60)] : [],
    staffComment: typeof payload.comment === "string" && payload.comment.trim() ? payload.comment.trim().slice(0, 1000) : null,
    responsibleUserId: actorId,
  };
  await tx.query("UPDATE bb.sheet_sync_records SET state = 'crm_managed', safe_review_code = NULL, missing_since = NULL, updated_at = now() WHERE source_key = $1", [record.source_key]);
  const card = await ensureCard(tx, actorId, reservationId, prefill);
  await writeEvent(tx, card.id, reservationId, actorId, "handed_over", { fromState: record.state, sourceRowNumber: record.source_row_number });
  await writeAudit(tx, { actorUserId: actorId, action: "booking.handed_over", entityType: "slot_reservation", entityId: reservationId, after: { fromState: record.state }, ...meta });
  return { cardId: card.id };
}
