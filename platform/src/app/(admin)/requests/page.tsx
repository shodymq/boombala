import type { Metadata } from "next";
import { BrandArt } from "@/components/brand-art";
import Link from "next/link";
import { listPackages } from "@/core/catalog";
import { isValidDate } from "@/core/dates";
import { LEAD_NEXT_ACTION_LABELS } from "@/core/lead-workflow";
import { DatePicker } from "@/components/date-picker";
import { Icon } from "@/components/icon";
import { requirePermissionAnd } from "@/server/dal";
import { getPool } from "@/server/db";
import { loadLeadPage, loadRequestsIndex } from "@/server/lead-data";
import { leadStatusAction } from "./actions";

export const metadata: Metadata = { title: "Ğ—Ğ°ÑĞ²ĞºĞ¸" };

const STATUS: Record<string, string> = { new: "ĞĞ¾Ğ²Ğ°Ñ", in_progress: "Ğ’ Ñ€Ğ°Ğ±Ğ¾Ñ‚Ğµ", confirmed: "ĞŸĞ¾Ğ´Ñ‚Ğ²ĞµÑ€Ğ¶Ğ´ĞµĞ½Ğ°", cancelled: "ĞÑ‚Ğ¼ĞµĞ½ĞµĞ½Ğ°", completed: "Ğ—Ğ°Ğ²ĞµÑ€ÑˆĞµĞ½Ğ°" };
const NOTICES: Record<string, string> = { status: "Ğ¡Ñ‚Ğ°Ñ‚ÑƒÑ Ğ¸Ğ·Ğ¼ĞµĞ½Ñ‘Ğ½.", workflow: "ĞŸĞ»Ğ°Ğ½ Ğ¾Ğ±Ñ€Ğ°Ğ±Ğ¾Ñ‚ĞºĞ¸ ÑĞ¾Ñ…Ñ€Ğ°Ğ½Ñ‘Ğ½.", claimed: "Ğ—Ğ°ÑĞ²ĞºĞ° Ğ½Ğ°Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ° Ğ²Ğ°Ğ¼." };
const ERRORS: Record<string, string> = {
  slot_taken: "Ğ­Ñ‚Ğ¾Ñ‚ ÑĞ»Ğ¾Ñ‚ ÑƒĞ¶Ğµ Ğ·Ğ°Ğ½ÑÑ‚. Ğ’Ñ‹Ğ±ĞµÑ€Ğ¸Ñ‚Ğµ Ğ´Ñ€ÑƒĞ³ÑƒÑ ĞºĞ¾Ğ¼Ğ½Ğ°Ñ‚Ñƒ Ğ¸Ğ»Ğ¸ Ğ²Ñ€ĞµĞ¼Ñ.",
  invalid: "ĞŸÑ€Ğ¾Ğ²ĞµÑ€ÑŒÑ‚Ğµ Ğ´Ğ°Ñ‚Ñƒ, ÑĞ»Ğ¾Ñ‚, ĞºĞ¾Ğ¼Ğ½Ğ°Ñ‚Ñƒ Ğ¸ Ğ¿Ğ°ĞºĞµÑ‚ (Ñƒ Ğ¿Ğ°ĞºĞµÑ‚Ğ° Ğ´Ğ¾Ğ»Ğ¶Ğ½Ğ° Ğ±Ñ‹Ñ‚ÑŒ Ñ†ĞµĞ½Ğ°; Ğ¿Ñ€Ğ¾ÑˆĞµĞ´ÑˆĞ¸Ğ¹ ÑĞ»Ğ¾Ñ‚ Ğ·Ğ°Ğ½ÑÑ‚ÑŒ Ğ½ĞµĞ»ÑŒĞ·Ñ).",
  conflict: "Ğ—Ğ°ÑĞ²ĞºĞ° ÑƒĞ¶Ğµ Ğ¾Ğ±Ñ€Ğ°Ğ±Ğ¾Ñ‚Ğ°Ğ½Ğ°.", forbidden: "ĞĞµĞ´Ğ¾ÑÑ‚Ğ°Ñ‚Ğ¾Ñ‡Ğ½Ğ¾ Ğ¿Ñ€Ğ°Ğ².", stale_update: "Ğ—Ğ°ÑĞ²ĞºÑƒ ÑƒĞ¶Ğµ Ğ¸Ğ·Ğ¼ĞµĞ½Ğ¸Ğ» Ğ´Ñ€ÑƒĞ³Ğ¾Ğ¹ ÑĞ¾Ñ‚Ñ€ÑƒĞ´Ğ½Ğ¸Ğº. ĞĞ±Ğ½Ğ¾Ğ²Ğ¸Ñ‚Ğµ ÑÑ‚Ñ€Ğ°Ğ½Ğ¸Ñ†Ñƒ Ğ¸ Ğ¿Ğ¾Ğ²Ñ‚Ğ¾Ñ€Ğ¸Ñ‚Ğµ Ğ´ĞµĞ¹ÑÑ‚Ğ²Ğ¸Ğµ.",
  lead_not_open: "ĞŸĞ»Ğ°Ğ½ Ğ¾Ğ±Ñ€Ğ°Ğ±Ğ¾Ñ‚ĞºĞ¸ Ğ¼Ğ¾Ğ¶Ğ½Ğ¾ Ğ¼ĞµĞ½ÑÑ‚ÑŒ Ñ‚Ğ¾Ğ»ÑŒĞºĞ¾ Ñƒ Ğ½Ğ¾Ğ²Ğ¾Ğ¹ Ğ·Ğ°ÑĞ²ĞºĞ¸ Ğ¸Ğ»Ğ¸ Ğ·Ğ°ÑĞ²ĞºĞ¸ Ğ² Ñ€Ğ°Ğ±Ğ¾Ñ‚Ğµ.", lead_already_assigned: "Ğ—Ğ°ÑĞ²ĞºĞ° ÑƒĞ¶Ğµ Ğ½Ğ°Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ° Ğ´Ñ€ÑƒĞ³Ğ¾Ğ¼Ñƒ ÑĞ¾Ñ‚Ñ€ÑƒĞ´Ğ½Ğ¸ĞºÑƒ.",
};
const input = "crm-requests-control";
const btn = "crm-requests-action";
const btnGhost = "crm-requests-action crm-requests-action-secondary";

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; createdFrom?: string; createdTo?: string; overdue?: string; page?: string; notice?: string; error?: string }> }) {
  const sp = await searchParams;
  const status = sp.status && STATUS[sp.status] ? sp.status : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const createdFrom = sp.createdFrom && isValidDate(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && isValidDate(sp.createdTo) ? sp.createdTo : undefined;
  const overdue = sp.overdue === "1";
  const hasFilters = Boolean(status || q || createdFrom || createdTo || overdue);
  const page = Math.max(Math.trunc(Number(sp.page)) || 1, 1);
  const filter = { status, q, createdFrom, createdTo, overdue, page };
  // Bridge mode: the page and the package names are ONE round trip that starts together with the session check.
  const { session, data: indexed } = await requirePermissionAnd("requests.manage", () => loadRequestsIndex(filter));
  const { user } = session;
  const actor = { id: user.id, role: user.role };
  let packages: Awaited<ReturnType<typeof listPackages>>;
  let result: Awaited<ReturnType<typeof loadLeadPage>>;
  if (indexed) {
    packages = indexed.packages;
    // Search, dates, status and pagination are executed by PostgreSQL (typed bridge operation `requests.index`).
    result = indexed.result;
  } else {
    const pool = getPool();
    packages = await listPackages(pool);
    result = await loadLeadPage(actor, filter);
  }
  const leads = result.items;
  const pages = Math.max(Math.ceil(result.total / result.pageSize), 1);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const pkgName = (id: string | null) => packages.find((p) => p.id === id)?.name ?? "Ğ½Ğµ Ğ²Ñ‹Ğ±Ñ€Ğ°Ğ½";
  function statusHref(next?: string, toPage?: number) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    if (overdue) params.set("overdue", "1");
    if (next) params.set("status", next);
    if (toPage && toPage > 1) params.set("page", String(toPage));
    const query = params.toString();
    return query ? `/requests?${query}` : "/requests";
  }

  return (
    <div className="crm-page crm-requests-page">
      <header className="crm-requests-heading">
        <div>
          <p className="crm-eyebrow">Ğ’Ñ…Ğ¾Ğ´ÑÑ‰Ğ¸Ğ¹ Ğ¿Ğ¾Ñ‚Ğ¾Ğº</p>
          <h1 className="crm-page-title">Ğ—Ğ°ÑĞ²ĞºĞ¸</h1>
          <p className="crm-page-subtitle">Ğ Ğ°Ğ±Ğ¾Ñ‡Ğ°Ñ Ğ¾Ñ‡ĞµÑ€ĞµĞ´ÑŒ Ğ¾Ğ±Ñ€Ğ°Ñ‰ĞµĞ½Ğ¸Ğ¹ Ñ„Ğ¸Ğ»Ğ¸Ğ°Ğ»Ğ°.</p>
        </div>
        <p className="crm-requests-count" aria-live="polite">Ğ’ÑĞµĞ³Ğ¾: <strong>{result.total}</strong></p>
      </header>
      <p className="crm-requests-note">Ğ—Ğ°ÑĞ²ĞºĞ° Ğ½Ğµ Ğ·Ğ°Ğ½Ğ¸Ğ¼Ğ°ĞµÑ‚ ÑĞ»Ğ¾Ñ‚. Ğ¡Ğ»Ğ¾Ñ‚ Ğ·Ğ°Ğ½Ğ¸Ğ¼Ğ°ĞµÑ‚ Ñ‚Ğ¾Ğ»ÑŒĞºĞ¾ Ğ¿Ğ¾Ğ´Ñ‚Ğ²ĞµÑ€Ğ¶Ğ´ĞµĞ½Ğ¸Ğµ. Ğ¦ĞµĞ½Ğ° Ñ„Ğ¸ĞºÑĞ¸Ñ€ÑƒĞµÑ‚ÑÑ Ğ² Ğ¼Ğ¾Ğ¼ĞµĞ½Ñ‚ Ğ¿Ğ¾Ğ´Ñ‚Ğ²ĞµÑ€Ğ¶Ğ´ĞµĞ½Ğ¸Ñ.</p>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{NOTICES[sp.notice]}</p> : null}5ëm­¢G§²ÚîÆ­yÖöFUU$”6ö×öæVçB†Âæ–B—ÖÒ6Æ74æÖS×¶'Fäv†÷7GÓí	í-­½-Â­-í}­3ÂôÆ–æ³à¢¶÷Vâò€¢ÆF—b6Æ74æÖSÒ&7&Ò×&WVW7G2×7FGW2Ö7F–öç2#à¢¶Âç7FGW2ÓÓÒ&æWr"òÆf÷&Ò7F–öã×¶ÆVE7FGW47F–öçÓãÆ–çWBG—SÒ&†–FFVâ"æÖSÒ&–B"fÇVS×¶Âæ–GÒóãÆ–çWBG—SÒ&†–FFVâ"æÖSÒ'7FGW2"fÇVSÒ&–å÷&öw&W72"óãÆ'WGFöâG—SÒ'7V&Ö—B"6Æ74æÖS×¶'Fäv†÷7GÓí	"í-3Âö'WGFöããÂöf÷&Óâ¢çVÆÇĞ¢Æf÷&Ò7F–öã×¶ÆVE7FGW47F–öçÓãÆ–çWBG—SÒ&†–FFVâ"æÖSÒ&–B"fÇVS×¶Âæ–GÒóãÆ–çWBG—SÒ&†–FFVâ"æÖSÒ'7FGW2"fÇVSÒ&6æ6VÆÆVB"óãÆ'WGFöâG—SÒ'7V&Ö—B"6Æ74æÖS×¶'Fäv†÷7GÓí	í-­½íİ-ÃÂö'WGFöããÂöf÷&Óà¢ÂöF—cà¢’¢çVÆÇĞ¢Â÷FCà¢Â÷G#à¢“°¢Ò—Ğ¢Â÷F&öG“à¢Â÷F&ÆSà¢¶ÆVG2æÆVæwF‚ÓÓÒò€¢Ç6Æ74æÖSÒ&7&Ò×&WVW7G2ÖV×G’"&öÆSÒ'7FGW2#à¢²†4f–ÇFW'2òÄ'&æD'B6Æ74æÖSÒ&×‚ÖWFòÖ"Ó2"6—¦S×³ƒ‡Òóâ¢çVÆÇĞ¢¶†4f–ÇFW'2ò-	ıâİ-Â=½í-ıÂ}ı-í¢İ]"â	}Í]İ-RM½Í-²½‚íÍ-Rıí¢â"¢-	}ı-í¢ıí­İ]"â	İí-½Rí]İòıíı-ı-ò}M]Ââ'Ğ¢Â÷à¢’¢çVÆÇĞ¢·vW2âò€¢Ææb6Æ74æÖSÒ&7&Ò×&WVW7G2×vW""&–ÖÆ&VÃÒ-
-İm²}ı-í¢#à¢·&W7VÇBçvRâòÄÆ–æ²‡&Vc×·7FGW4‡&Vb‡7FGW2Â&W7VÇBçvRÒ—Ò&VÃÒ'&Wb"6Æ74æÖS×¶'Fäv†÷7GÓî(i	İ}CÂôÆ–æ³â¢çVÆÇĞ¢Ç7â&–ÖÆ—fSÒ'öÆ—FR#í
-İm·&W7VÇBçvWÒr·vW7ÓÂ÷7ãà¢·&W7VÇBçvRÂvW2òÄÆ–æ²‡&Vc×·7FGW4‡&Vb‡7FGW2Â&W7VÇBçvR²—Ò&VÃÒ&æW‡B"6Æ74æÖS×¶'Fäv†÷7GÓí	-ı]B(i#ÂôÆ–æ³â¢çVÆÇĞ¢Âöæcà¢’¢çVÆÇĞ¢Â÷6V7F–öãà¢ÂöF—cà¢“°§Ğ