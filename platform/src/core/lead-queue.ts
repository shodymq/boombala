import type { Pool } from "./db.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import { assertCan, can, type Actor } from "./rbac.ts";
import type { LeadRow } from "./bookings.ts";
import type { LeadNextAction } from "./lead-workflow.ts";

/**
 * The request queue: server-side search, pagination, a single record by id and the dashboard counters.
 * Read-only. Writes (status, confirmation) stay in bookings.ts and the calendar flow.
 */
export const LEAD_PAGE_SIZE = 25;
export const LEAD_PAGE_SIZE_MAX = 100;
export const LEAD_STATUSES = ["new", "in_progress", "confirmed", "cancelled", "completed"] as const;

export interface LeadFilter {
  status?: string;
  /** Free text: a part of the name, or at least three digits of the phone. */
  q?: string;
  /** Dates of creation, Asia/Almaty calendar days, inclusive. */
  createdFrom?: string;
  createdTo?: string;
  /** Open requests whose planned follow-up time has passed. */
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export interface LeadQueueItem extends LeadRow {
  assignedTo: string | null;
  assigneeName: string | null;
  nextAction: LeadNextAction | null;
  followUpAt: Date | null;
  workflowVersion: number;
  followUpOverdue: boolean;
}

export interface LeadPage {
  items: LeadQueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeadDetail extends LeadQueueItem {
  /** Manual prepayment fact in tenge, or null when none is recorded. */
  prepaymentKzt: number | null;
}

const LEAD_COLUMNS = `l.id, l.seq, l.created_at, l.status, c.name, c.phone_e164, to_char(l.requested_date, 'YYYY-MM-DD') AS requested_date,
            l.slot_id, to_char(l.preferred_start_time, 'HH24:MI') AS preferred_start_time, l.room_id, l.package_id, l.children,
            l.assigned_to, assignee.name AS assignee_name, l.next_action, l.follow_up_at, l.workflow_version,
            (l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')) AS follow_up_overdue,
            (SELECT r.id FROM bb.slot_reservations r WHERE r.lead_request_id = l.id AND r.released_at IS NULL) AS reservation_id`;

function leadRow(r: Record<string, unknown>): LeadQueueItem {
  return {
    id: r.id as string,
    seq: Number(r.seq),
    createdAt: r.created_at as Date,
    status: r.status as string,
    name: r.name as string,
    phone: r.phone_e164 as string,
    requestedDate: r.requested_date as string,
    slotId: r.slot_id as number | null,
    preferredStartTime: r.preferred_start_time as string | null,
    roomId: r.room_id as string | null,
    packageId: r.package_id as string | null,
    children: r.children as number | null,
    reservationId: r.reservation_id as string | null,
    assignedTo: r.assigned_to as string | null,
    assigneeName: r.assignee_name as string | null,
    nextAction: r.next_action as LeadNextAction | null,
    followUpAt: r.follow_up_at as Date | null,
    workflowVersion: Number(r.workflow_version),
    followUpOverdue: r.follow_up_overdue === true,
  };
}

const LIKE_SPECIALS = /[\\%_]/g;
const NON_DIGITS = /\D/g;

/** Filters and paginates in PostgreSQL. A malformed filter is a validation error, never a silent "all rows". */
export async function searchLeads(pool: Pool, actor: Actor, filter: LeadFilter = {}): Promise<LeadPage> {
  assertCan(actor, "requests.manage");
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError({ status: "invalid" });
    where.push(`l.status = ${add(filter.status)}`);
  }
  if (filter.createdFrom !== undefined) {
    if (!isValidDate(filter.createdFrom)) throw new ValidationError({ createdFrom: "invalid" });
    where.push(`(l.created_at AT TIME ZONE 'Asia/Almaty')::date >= ${add(filter.createdFrom)}::date`);
  }
  if (filter.createdTo !== undefined) {
    if (!isValidDate(filter.createdTo)) throw new ValidationError({ createdTo: "invalid" });
    where.push(`(l.created_at AT TIME ZONE 'Asia/Almaty')::date <= ${add(filter.createdTo)}::date`);
  }
  if (filter.overdue === true) where.push("l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')");
  const q = filter.q?.trim().slice(0, 80);
  if (q) {
    const digits = q.replace(NON_DIGITS, "");
    const name = add(`%${q.replace(LIKE_SPECIALS, (c) => `\\${c}`)}%`);
    where.push(
      digits.length >= 3
        ? `(c.name ILIKE ${name} OR regexp_replace(c.phone_e164, '[^0-9]', '', 'g') LIKE ${add(`%${digits}%`)})`
        : `c.name ILIKE ${name}`,
    );
  }
  const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? LEAD_PAGE_SIZE) || LEAD_PAGE_SIZE, 1), LEAD_PAGE_SIZE_MAX);
  const requested = Math.max(Math.trunc(filter.page ?? 1) || 1, 1);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const counted = await pool.query(`SELECT count(*)::int AS n FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id ${clause}`, params);
  const total = Number(counted.rows[0].n);
  // A page past the end falls back to the last page, so a stale link shows data instead of an empty screen.
  const page = Math.min(requested, Math.max(Math.ceil(total / pageSize), 1));
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLUMNS}
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id LEFT JOIN bb.users assignee ON assignee.id = l.assigned_to
       ${clause} ORDER BY (l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')) DESC,
         (l.status IN ('new', 'in_progress')) DESC, l.requested_date, l.seq DESC
       LIMIT ${add(pageSize)} OFFSET ${add((page - 1) * pageSize)}`,
    params,
  );
  return { items: rows.map(leadRow), total, page, pageSize };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One record by id, with the manual prepayment fact. Null when there is no such request. */
export async function getLead(pool: Pool, actor: Actor, id: string): Promise<LeadDetail | null> {
  assertCan(actor, "requests.manage");
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLUMNS}, (SELECT p.amount_kzt FROM bb.manual_payment_facts p WHERE p.lead_request_id = l.id ORDER BY p.created_at LIMIT 1) AS prepayment_kzt
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id LEFT JOIN bb.users assignee ON assignee.id = l.assigned_to WHERE l.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  return { ...leadRow(rows[0]), prepaymentKzt: rows[0].prepayment_kzt === null ? null : Number(rows[0].prepayment_kzt) };
}

export interface DashboardCounters {
  /** Asia/Almaty calendar day the booking counters refer to. */
  date: string;
  requests: { new: number; inProgress: number } | null;
  bookings: { booked: number; blocked: number } | null;
}

/** Real counters only. Requests need `requests.manage`, bookings and blocks need `bookings.manage`; otherwise null, never zero. */
export async function dashboardCounters(pool: Pool, role: Actor["role"]): Promise<DashboardCounters> {
  const date = almatyToday();
  const [requests, bookings] = await Promise.all([
    can(role, "requests.manage")
      ? pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM bb.lead_requests WHERE status IN ('new', 'in_progress') GROUP BY status")
      : Promise.resolve(null),
    can(role, "bookings.manage")
      ? pool.query<{ kind: string; ßÏ-¢G§²ÚîÆ­yÔEôäU…Eô5D”ôå2•¶çVÖ&W%Ó° ¦W‡÷'B6öç7BÄTEôäU…Eô5D”ôåôÄ$TÅ3¢&V6÷&CÄÆVDæW‡D7F–öâÂ7G&–æsâÒ°¢6ÆÅö7W7FöÖW#¢-	ýí}-íÝ-Â­½]Ý-2"À¢6Æ&–g•öFWF–Ç3¢-
=-í}Ý-ÂM]-½‚"À¢&W&UööffW#¢-	ýíM=í-í--Âý]M½ím]ÝR"À¢v—E÷&WÇ“¢-	ímM-Âí--]-"À¢66†VGVÆU÷f—6—C¢-
í=½í--Â-}""À§Ó° ¦6öç7BUT”BÒõå³Ó–Öe×³‡ÒÕ³Ó–Öe×³GÒÕ³Ó…Õ³Ó–Öe×³7ÒÕ³ƒ–%Õ³Ó–Öe×³7ÒÕ³Ó–Öe×³'ÒBö“°¦6öç7BÄô4ÅôDDUD”ÔRÒõâ…ÆG³GÒ’Ò…ÆG³'Ò’Ò…ÆG³'Ò•B…³ÕÆGÃ%³Ó5Ò“¢…³ÓUÕÆB’Bó°¦6öç7BÆÖG”f÷&ÖGFW"ÒæWr–çFÂäFFUF–ÖTf÷&ÖB‚&VâÔ4"Â°¢F–ÖU¦öæS¢$6–ôÆÖG’"Â–V#¢&çVÖW&–2"ÂÖöçFƒ¢#"ÖF–v—B"ÂF“¢#"ÖF–v—B"À¢†÷W#¢#"ÖF–v—B"ÂÖ–çWFS¢#"ÖF–v—B"Â†÷W$7–6ÆS¢&ƒ#2"À§Ò“° ¦gVæ7F–öâÆö6Å'G2†FFS¢FFR“¢çVÖ&W%µÒ°¢6öç7BÒö&¦V7Bæg&öÔVçG&–W2†ÆÖG”f÷&ÖGFW"æf÷&ÖEFõ'G2†FFR’æÖ‚‡‚’Óâ·‚çG—RÂ‚çfÇVUÒ’“°¢&WGW&â´çVÖ&W"‡ç–V"’ÂçVÖ&W"‡æÖöçF‚’ÂçVÖ&W"‡æF’’ÂçVÖ&W"‡æ†÷W"’ÂçVÖ&W"‡æÖ–çWFR•Ó°§Ð ¢ò¢¢6öçfW'G2'&÷w6W"FFWF–ÖRÖÆö6ÂfÇVR–â6–ôÆÖG’–çFòâ–ç7FçBv—F†÷WBW6–ærF†R†÷7BF–ÖW¦öæRâ¢ð¦W‡÷'BgVæ7F–öâÆÖG”Æö6ÄFFUF–ÖUFô–ç7FçB‡fÇVS¢7G&–ær“¢FFR°¢6öç7BÖF6‚ÒÄô4ÅôDDUD”ÔRæW†V2‡fÇVR“°¢–b‚ÖF6‚’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²föÆÆ÷uWC¢&–çfÆ–B"Ò“°¢6öç7BvçFVBÒÖF6‚ç6Æ–6Rƒ’æÖ„çVÖ&W"“°¢6öç7B·–V"ÂÖöçF‚ÂF’Â†÷W"ÂÖ–çWFUÒÒvçFVC°¢6öç7BvÆÄWö6‚ÒFFRåUD2‡–V"ÂÖöçF‚ÒÂF’Â†÷W"ÂÖ–çWFR“°¢6öç7BvÆÂÒæWrFFR‡vÆÄWö6‚“°¢–b‡vÆÂævWEUD4gVÆÅ–V"‚’ÓÒ–V"ÇÂvÆÂævWEUD4ÖöçF‚‚’²ÓÒÖöçF‚ÇÂvÆÂævWEUD4FFR‚’ÓÒF’ÇÂvÆÂævWEUD4†÷W'2‚’ÓÒ†÷W"ÇÂvÆÂævWEUD4Ö–çWFW2‚’ÓÒÖ–çWFR’°¢F‡&÷ræWrfÆ–FF–öäW'&÷"‡²föÆÆ÷uWC¢&–çfÆ–B"Ò“°¢Ð ¢òò&W6öÇfRF†R¦öæRöfg6WBg&öÒ–çFÂ–ç7FVBöb77VÖ–ærF†RæöFRõfW&6VÂ&ö6W72F–ÖW¦öæRà¢ÆWBWö6‚ÒvÆÄWö6ƒ°¢f÷"†ÆWBGFV×BÒ²GFV×BÂ3²GFV×B³Ò’°¢6öç7Bv÷BÒÆö6Å'G2†æWrFFR†Wö6‚’“°¢6öç7Bö'6W'fVEvÆÄWö6‚ÒFFRåUD2†v÷E³ÒÂv÷E³ÒÒÂv÷E³%ÒÂv÷E³5ÒÂv÷E³EÒ“°¢Wö6‚³ÒvÆÄWö6‚Òö'6W'fVEvÆÄWö6ƒ°¢Ð¢6öç7B&W7VÇBÒæWrFFR†Wö6‚“°¢–b†Æö6Å'G2‡&W7VÇB’ç6öÖR‚‡'BÂ–æFW‚’Óâ'BÓÒvçFVE¶–æFW…Ò’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²föÆÆ÷uWC¢&–çfÆ–B"Ò“°¢&WGW&â&W7VÇC°§Ð ¦W‡÷'BgVæ7F–öâ–ç7FçEFôÆÖG”Æö6ÄFFUF–ÖR‡fÇVS¢FFRÂ7G&–ærÂçVÆÂ“¢7G&–ær°¢–b‡fÇVRÓÓÒçVÆÂ’&WGW&â"#°¢6öç7B'G2ÒÆö6Å'G2‡fÇVR–ç7Fæ6VöbFFRòfÇVR¢æWrFFR‡fÇVR’“°¢6öç7B·–V"ÂÖöçF‚ÂF’Â†÷W"ÂÖ–çWFUÒÒ'G3°¢&WGW&âG·–V'ÒÒGµ7G&–ær†ÖöçF‚’çE7F'Bƒ"Â#"—ÒÒGµ7G&–ær†F’’çE7F'Bƒ"Â#"—ÕBGµ7G&–ær††÷W"’çE7F'Bƒ"Â#"—Ó¢Gµ7G&–ær†Ö–çWFR’çE7F'Bƒ"Â#"—Ö°§Ð ¦W‡÷'B–çFW&f6RÆVEv÷&¶fÆ÷uWFFT–çWB°¢ÆVD–C¢7G&–æs°¢W‡V7FVEfW'6–öã¢çVÖ&W#°¢76–væVEFó¢7G&–ærÂçVÆÃ°¢æW‡D7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ°¢föÆÆ÷uWDÆö6Ã¢7G&–ærÂçVÆÃ°§Ð ¦W‡÷'B–çFW&f6RÆVEv÷&¶fÆ÷t6Æ–Ô–çWB²ÆVD–C¢7G&–æs²W‡V7FVEfW'6–öã¢çVÖ&W"Ð ¦W‡÷'BgVæ7F–öâ'6TÆVEv÷&¶fÆ÷uWFFR‡fÇVS¢Væ¶æ÷vâ“¢ÆVEv÷&¶fÆ÷uWFFT–çWB°¢–b‚fÇVRÇÂG—VöbfÇVRÓÒ&ö&¦V7B"ÇÂ'&’æ—4'&’‡fÇVR’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²–çWC¢&–çfÆ–B"Ò“°¢6öç7B–çWBÒfÇVR2&V6÷&CÇ7G&–ærÂVæ¶æ÷vãã°¢6öç7BÆVD–BÒG—Vöb–çWBæÆVD–BÓÓÒ'7G&–ær"ò–çWBæÆVD–B¢"#°¢6öç7BW‡V7FVEfW'6–öâÒ–çWBæW‡V7FVEfW'6–öã°¢6öç7B76–væVEFòÒ–çWBæ76–væVEFó°¢6öç7BæW‡D7F–öâÒ–çWBææW‡D7F–öã°¢6öç7BföÆÆ÷uWDÆö6ÂÒ–çWBæföÆÆ÷uWDÆö6Ã°¢–b‚UT”BçFW7B†ÆVD–B’ÇÂçVÖ&W"æ—56fT–çFVvW"†W‡V7FVEfW'6–öâ’ÇÂçVÖ&W"†W‡V7FVEfW'6–öâ’Â’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²–çWC¢&–çfÆ–B"Ò“°¢–b†76–væVEFòÓÒçVÆÂbb‡G—Vöb76–væVEFòÓÒ'7G&–ær"ÇÂUT”BçFW7B†76–væVEFò’’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²76–væVEFó¢&–çfÆ–B"Ò“°¢–b†æW‡D7F–öâÓÒçVÆÂbb„ÄTEôäU…Eô5D”ôå22&VFöæÇ’Væ¶æ÷våµÒ’æ–æ6ÇVFW2†æW‡D7F–öâ’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²æW‡D7F–öã¢&–çfÆ–B"Ò“°¢–b†föÆÆ÷uWDÆö6ÂÓÒçVÆÂbbG—VöbföÆÆ÷uWDÆö6ÂÓÒ'7G&–ær"’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²föÆÆ÷uWC¢&–çfÆ–B"Ò“°¢6öç7BÆö6ÂÒföÆÆ÷uWDÆö6Â27G&–ærÂçVÆÃ°¢–b‚†æW‡D7F–öâÓÓÒçVÆÂ’ÓÒ†Æö6ÂÓÓÒçVÆÂ’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²föÆÆ÷uWC¢&7F–öåöæE÷F–ÖU÷&WV—&VE÷FövWF†W""Ò“°¢–b†Æö6ÂÓÒçVÆÂ’ÆÖG”Æö6ÄFFUF–ÖUFô–ç7FçB†Æö6Â“°¢&WGW&â²ÆVD–BÂW‡V7FVEfW'6–öã¢çVÖ&W"†W‡V7FVEfW'6–öâ’Â76–væVEFó¢76–væVEFò27G&–ærÂçVÆÂÂæW‡D7F–öã¢æW‡D7F–öâ2ÆVDæW‡D7F–öâÂçVÆÂÂföÆÆ÷uWDÆö6Ã¢Æö6ÂÓ°§Ð ¦W‡÷'BgVæ7F–öâ'6TÆVEv÷&¶fÆ÷t6Æ–Ò‡fÇVS¢Væ¶æ÷vâ“¢ÆVEv÷&¶fÆ÷t6Æ–Ô–çWB°¢–b‚fÇVRÇÂG—VöbfÇVRÓÒ&ö&¦V7B"ÇÂ'&’æ—4'&’‡fÇVR’’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²–çWC¢&–çfÆ–B"Ò“°¢6öç7B–çWBÒfÇVR2&V6÷&CÇ7G&–ærÂVæ¶æ÷vãã°¢–b‡G—Vöb–çWBæÆVD–BÓÒ'7G&–ær"ÇÂUT”BçFW7B†–çWBæÆVD–B’ÇÂçVÖ&W"æ—56fT–çFVvW"†–çWBæW‡V7FVEfW'6–öâ’ÇÂçVÖ&W"†–çWBæW‡V7FVEfW'6–öâ’Â’°¢F‡&÷ræWrfÆ–FF–öäW'&÷"‡²–çWC¢&–çfÆ–B"Ò“°¢Ð¢&WGW&â²ÆVD–C¢–çWBæÆVD–BÂW‡V7FVEfW'6–öã¢çVÖ&W"†–çWBæW‡V7FVEfW'6–öâ’Ó°§Ð §G—Rv÷&¶fÆ÷u&÷rÒ°¢–C¢7G&–æs²7FGW3¢7G&–æs²76–væVE÷Fó¢7G&–ærÂçVÆÃ²76–væVEöæÖS¢7G&–ærÂçVÆÃ²æW‡Eö7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ°¢föÆÆ÷u÷WöC¢FFRÂçVÆÃ²v÷&¶fÆ÷u÷fW'6–öã¢çVÖ&W#°§Ó°§G—RVF—DÖWFÒ²—ó¢7G&–ærÂçVÆÃ²W6W$vVçCó¢7G&–ærÂçVÆÂÓ° ¦7–æ2gVæ7F–öâw&—FUv÷&¶fÆ÷r€¢ööÃ¢ööÂÀ¢7F÷#¢7F÷"À¢–çWC¢ÆVEv÷&¶fÆ÷uWFFT–çWBÀ¢ÖWF¢VF—DÖWFÀ¢ÖöFS¢'WFFR"Â&6Æ–Ò"À¢“¢&öÖ—6SÇ²fW'6–öã¢çVÖ&W#²76–væVEFó¢7G&–ærÂçVÆÃ²æW‡D7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ²föÆÆ÷uWC¢7G&–ærÂçVÆÂÓâ°¢76W'D6â†7F÷"Â'&WVW7G2æÖævR"“°¢6öç7BföÆÆ÷uWBÒ–çWBæföÆÆ÷uWDÆö6ÂÓÓÒçVÆÂòçVÆÂ¢ÆÖG”Æö6ÄFFUF–ÖUFô–ç7FçB†–çWBæföÆÆ÷uWDÆö6Â“° ¢&WGW&âv—F…G‚‡ööÂÂ7–æ2‡G‚’Óâ°¢6öç7B6VÆV7FVBÒv—BG‚çVW'“Åv÷&¶fÆ÷u&÷sâ€¢4TÄT5BÂæ–BÂÂç7FGW2ÂÂæ76–væVE÷FòÂRææÖR276–væVEöæÖRÂÂææW‡Eö7F–öâÂÂæföÆÆ÷u÷WöBÂÂçv÷&¶fÆ÷u÷fW'6–öà¢e$ôÒ&"æÆVE÷&WVW7G2ÂÄTeB¤ô”â&"çW6W'2RôâRæ–BÒÂæ76–væVE÷Fòt„U$RÂæ–BÒCdõ"UDDRôbÆÀ¢¶–çWBæÆVD–EÒÀ¢“°¢6öç7B&Vf÷&RÒ6VÆV7FVBç&÷w5³Ó°¢–b‚&Vf÷&R’F‡&÷ræWræ÷Df÷VæDW'&÷"‚“°¢–b†&Vf÷&Rçv÷&¶fÆ÷u÷fW'6–öâÓÒ–çWBæW‡V7FVEfW'6–öâ’F‡&÷ræWr6öæfÆ–7DW'&÷"‚'7FÆU÷WFFR"“°¢–b†&Vf÷&Rç7FGW2ÓÒ&æWr"bb&Vf÷&Rç7FGW2ÓÒ&–å÷&öw&W72"’F‡&÷ræWr6öæfÆ–7DW'&÷"‚&ÆVEöæ÷Eö÷Vâ"“° ¢6öç7BæW‡D76–væVEFòÒÖöFRÓÓÒ&6Æ–Ò"ò7F÷"æ–B¢–çWBæ76–væVEFó°¢–b†ÖöFRÓÓÒ&6Æ–Ò"bb&Vf÷&Ræ76–væVE÷Fòbb&Vf÷&Ræ76–væVE÷FòÓÒ7F÷"æ–B’F‡&÷ræWr6öæfÆ–7DW'&÷"‚&ÆVEöÇ&VG•ö76–væVB"“°¢ÆWBæW‡D76–væVDæÖS¢7G&–ærÂçVÆÂÒçVÆÃ°¢–b†æW‡D76–væVEFò’°¢6öç7B76–væVBÒv—BG‚çVW'“Ç²æÖS¢7G&–ærÓâ€¢%4TÄT5BæÖRe$ôÒ&"çW6W'2t„U$R–BÒCäB—5ö7F—fRäB&öÆS£§FW‡B”â‚v÷væW"rÂvÖævW"r’"À¢¶æW‡D76–væVEFõÒÀ¢“°¢–b‚76–væVBç&÷w5³Ò’F‡&÷ræWrfÆ–FF–öäW'&÷"‡²76–væVEFó¢&æ÷Eö76–væ&ÆR"Ò“°¢æW‡D76–væVDæÖRÒ76–væVBç&÷w5³ÒææÖS°¢Ð¢6öç7BæW‡D7F–öâÒÖöFRÓÓÒ&6Æ–Ò"ò&Vf÷&RææW‡Eö7F–öâ¢–çWBææW‡D7F–öã°¢6öç7BæW‡DföÆÆ÷uWBÒÖöFRÓÓÒ&6Æ–Ò"ò&Vf÷&RæföÆÆ÷u÷WöB¢föÆÆ÷uWC°¢6öç7B6ÖT–ç7FçBÒ†¢FFRÂçVÆÂÂ#¢FFRÂçVÆÂ’Óâ†òævWEF–ÖR‚’óòçVÆÂ’ÓÓÒ†#òævWEF–ÖR‚’óòçVÆÂ“°¢6öç7BVæ6†ævVBÒ&Vf÷&Ræ76–væVE÷FòÓÓÒæW‡D76–væVEFòbb&Vf÷&RææW‡Eö7F–öâÓÓÒæW‡D7F–öâbb6ÖT–ç7FçB†&Vf÷&RæföÆÆ÷u÷WöBÂæW‡DföÆÆ÷uWB“°¢–b‡Væ6†ævVB’&WGW&â²fW'6–öã¢&Vf÷&Rçv÷&¶fÆ÷u÷fW'6–öâÂ76–væVEFó¢&Vf÷&Ræ76–væVE÷FòÂæW‡D7F–öã¢&Vf÷&RææW‡Eö7F–öâÂföÆÆ÷uWC¢&Vf÷&RæföÆÆ÷u÷WöCòçFô•4õ7G&–ær‚’óòçVÆÂÓ° ¢6öç7BWFFVBÒv—BG‚çVW'“Ç²v÷&¶fÆ÷u÷fW'6–öã¢çVÖ&W#²76–væVE÷Fó¢7G&–ærÂçVÆÃ²æW‡Eö7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ²föÆÆ÷u÷WöC¢FFRÂçVÆÂÓâ€¢UDDR&"æÆVE÷&WVW7G0¢4UB76–væVE÷FòÒC2ÂæW‡Eö7F–öâÒCBÂföÆÆ÷u÷WöBÒCRÂv÷&¶fÆ÷u÷fW'6–öâÒv÷&¶fÆ÷u÷fW'6–öâ²¢t„U$R–BÒCäBv÷&¶fÆ÷u÷fW'6–öâÒC"äB7FGW2”â‚væWrrÂv–å÷&öw&W72r¢$UEU$ä”ärv÷&¶fÆ÷u÷fW'6–öâÂ76–væVE÷FòÂæW‡Eö7F–öâÂföÆÆ÷u÷WöFÀ¢¶–çWBæÆVD–BÂ–çWBæW‡V7FVEfW'6–öâÂæW‡D76–væVEFòÂæW‡D7F–öâÂæW‡DföÆÆ÷uWEÒÀ¢“°¢–b‚WFFVBç&÷w5³Ò’F‡&÷ræWr6öæfÆ–7DW'&÷"‚'7FÆU÷WFFR"“°¢6öç7BgFW"ÒWFFVBç&÷w5³Ó°¢v—Bw&—FTVF—B‡G‚Â°¢7F÷%W6W$–C¢7F÷"æ–BÀ¢7F–öã¢ÖöFRÓÓÒ&6Æ–Ò"ò&ÆVBæ6Æ–ÖVB"¢&ÆVBçv÷&¶fÆ÷u÷WFFVB"À¢VçF—G•G—S¢&ÆVE÷&WVW7B"À¢VçF—G”–C¢–çWBæÆVD–BÀ¢&Vf÷&S¢²76–væVEFó¢&Vf÷&Ræ76–væVE÷FòÂ76–væVTæÖS¢&Vf÷&Ræ76–væVEöæÖRÂæW‡D7F–öã¢&Vf÷&RææW‡Eö7F–öâÂföÆÆ÷uWC¢&Vf÷&RæföÆÆ÷u÷WöCòçFô•4õ7G&–ær‚’óòçVÆÂÂfW'6–öã¢&Vf÷&Rçv÷&¶fÆ÷u÷fW'6–öâÒÀ¢gFW#¢²76–væVEFó¢gFW"æ76–væVE÷FòÂ76–væVTæÖS¢æW‡D76–væVDæÖRÂæW‡D7F–öã¢gFW"ææW‡Eö7F–öâÂföÆÆ÷uWC¢gFW"æföÆÆ÷u÷WöCòçFô•4õ7G&–ær‚’óòçVÆÂÂfW'6–öã¢gFW"çv÷&¶fÆ÷u÷fW'6–öâÒÀ¢ââæÖWFÀ¢Ò“°¢&WGW&â²fW'6–öã¢gFW"çv÷&¶fÆ÷u÷fW'6–öâÂ76–væVEFó¢gFW"æ76–væVE÷FòÂæW‡D7F–öã¢gFW"ææW‡Eö7F–öâÂföÆÆ÷uWC¢gFW"æföÆÆ÷u÷WöCòçFô•4õ7G&–ær‚’óòçVÆÂÓ°¢Ò“°§Ð ¦W‡÷'B7–æ2gVæ7F–öâWFFTÆVEv÷&¶fÆ÷r‡ööÃ¢ööÂÂ7F÷#¢7F÷"Â&t–çWC¢Væ¶æ÷vâÂÖWF¢VF—DÖWFÒ·Ò’°¢6öç7B–çWBÒ'6TÆVEv÷&¶fÆ÷uWFFR‡&t–çWB“°¢&WGW&âw&—FUv÷&¶fÆ÷r‡ööÂÂ7F÷"Â–çWBÂÖWFÂ'WFFR"“°§Ð ¦W‡÷'B7–æ2gVæ7F–öâ6Æ–ÔÆVB‡ööÃ¢ööÂÂ7F÷#¢7F÷"Â&t–çWC¢Væ¶æ÷vâÂÖWF¢VF—DÖWFÒ·Ò’°¢6öç7B–çWBÒ'6TÆVEv÷&¶fÆ÷t6Æ–Ò‡&t–çWB“°¢&WGW&âw&—FUv÷&¶fÆ÷r‡ööÂÂ7F÷"Â²ââæ–çWBÂ76–væVEFó¢7F÷"æ–BÂæW‡D7F–öã¢çVÆÂÂföÆÆ÷uWDÆö6Ã¢çVÆÂÒÂÖWFÂ&6Æ–Ò"“°§Ð ¦W‡÷'B–çFW&f6RÆVD76–væVR²–C¢7G&–æs²æÖS¢7G&–æs²&öÆS¢&÷væW""Â&ÖævW""Ð¦W‡÷'B–çFW&f6RÆVEv÷&¶fÆ÷t†—7F÷'’°¢–C¢çVÖ&W#²C¢FFS²7F÷$æÖS¢7G&–ærÂçVÆÃ²7F–öã¢&ÆVBæ6Æ–ÖVB"Â&ÆVBçv÷&¶fÆ÷u÷WFFVB#°¢&Vf÷&S¢²76–væVEFó¢7G&–ærÂçVÆÃ²76–væVTæÖS¢7G&–ærÂçVÆÃ²æW‡D7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ²föÆÆ÷uWC¢7G&–ærÂçVÆÂÓ°¢gFW#¢²76–væVEFó¢7G&–ærÂçVÆÃ²76–væVTæÖS¢7G&–ærÂçVÆÃ²æW‡D7F–öã¢ÆVDæW‡D7F–öâÂçVÆÃ²föÆÆ÷uWC¢7G&–ærÂçVÆÂÓ°§Ð¦W‡÷'B–çFW&f6RÆVEv÷&¶fÆ÷t6öçFW‡B²76–væVW3¢ÆVD76–væVUµÓ²†—7F÷'“¢ÆVEv÷&¶fÆ÷t†—7F÷'•µÒÐ ¦gVæ7F–öâVF—E6æ6†÷B‡fÇVS¢Væ¶æ÷vâ“¢ÆVEv÷&¶fÆ÷t†—7F÷'•²&&Vf÷&R%Ò°¢6öç7BbÒfÇVRbbG—VöbfÇVRÓÓÒ&ö&¦V7B"òfÇVR2&V6÷&CÇ7G&–ærÂVæ¶æ÷vãâ¢·Ó°¢&WGW&â°¢76–væVEFó¢G—Vöbbæ76–væVEFòÓÓÒ'7G&–ær"òbæ76–væVEFò¢çVÆÂÀ¢76–væVTæÖS¢G—Vöbbæ76–væVTæÖRÓÓÒ'7G&–ær"òbæ76–væVTæÖR¢çVÆÂÀ¢æW‡D7F–öã¢G—VöbbææW‡D7F–öâÓÓÒ'7G&–ær"bb„ÄTEôäU…Eô5D”ôå22&VFöæÇ’7G&–æuµÒ’æ–æ6ÇVFW2‡bææW‡D7F–öâ’òbææW‡D7F–öâ2ÆVDæW‡D7F–öâ¢çVÆÂÀ¢föÆÆ÷uWC¢G—VöbbæföÆÆ÷uWBÓÓÒ'7G&–ær"òbæföÆÆ÷uWB¢çVÆÂÀ¢Ó°§Ð ¦W‡÷'B7–æ2gVæ7F–öâvWDÆVEv÷&¶fÆ÷t6öçFW‡B‡ööÃ¢ööÂÂ7F÷#¢7F÷"ÂÆVD–C¢7G&–ær“¢&öÖ—6SÄÆVEv÷&¶fÆ÷t6öçFW‡Câ°¢76W'D6â†7F÷"Â'&WVW7G2æÖævR"“°¢–b‚UT”BçFW7B†ÆVD–B’’F‡&÷ræWræ÷Df÷VæDW'&÷"‚“°¢6öç7BW†—7G2Òv—BööÂçVW'’‚%4TÄT5Be$ôÒ&"æÆVE÷&WVW7G2t„U$R–BÒC"Â¶ÆVD–EÒ“°¢–b‚W†—7G2ç&÷t6÷VçB’F‡&÷ræWræ÷Df÷VæDW'&÷"‚“°¢6öç7B¶76–væVW2ÂWfVçG5ÒÒv—B&öÖ—6RæÆÂ…°¢ööÂçVW'“Ç²–C¢7G&–æs²æÖS¢7G&–æs²&öÆS¢&÷væW""Â&ÖævW""Óâ€¢%4TÄT5B–BÂæÖRÂ&öÆS£§FW‡B2&öÆRe$ôÒ&"çW6W'2t„U$R—5ö7F—fRäB&öÆS£§FW‡B”â‚v÷væW"rÂvÖævW"r’õ$DU"%’44R&öÆS£§FW‡Bt„Tâv÷væW"rD„TâTÅ4RTäBÂæÖRÂ–B"À¢’À¢ööÂçVW'“Ç²–C¢7G&–æs²C¢FFS²7F÷%öæÖS¢7G&–ærÂçVÆÃ²7F–öã¢ÆVEv÷&¶fÆ÷t†—7F÷'•²&7F–öâ%Ó²&Vf÷&S¢Væ¶æ÷vã²gFW#¢Væ¶æ÷vâÓâ€¢4TÄT5Bæ–BÂæBÂRææÖR27F÷%öæÖRÂæ7F–öâÂæ&Vf÷&RÂægFW ¢e$ôÒ&"æVF—EöÆörÄTeB¤ô”â&"çW6W'2RôâRæ–BÒæ7F÷%÷W6W%ö–@¢t„U$RæVçF—G•÷G—RÒvÆVE÷&WVW7BräBæVçF—G•ö–BÒCäBæ7F–öâ”â‚vÆVBæ6Æ–ÖVBrÂvÆVBçv÷&¶fÆ÷u÷WFFVBr¢õ$DU"%’æ–BDU42Ä”Ô•BSÀ¢¶ÆVD–EÒÀ¢’À¢Ò“°¢&WGW&â°¢76–væVW3¢76–væVW2ç&÷w2À¢†—7F÷'“¢WfVçG2ç&÷w2æÖ‚‡&÷r’Óâ‡²–C¢çVÖ&W"‡&÷ræ–B’ÂC¢&÷ræBÂ7F÷$æÖS¢&÷ræ7F÷%öæÖRÂ7F–öã¢&÷ræ7F–öâÂ&Vf÷&S¢VF—E6æ6†÷B‡&÷ræ&Vf÷&R’ÂgFW#¢VF—E6æ6†÷B‡&÷rægFW"’Ò’’À¢Ó°§Ð 