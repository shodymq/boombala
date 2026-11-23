import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listPackages, listRooms, listSlots } from "@/core/catalog";
import { getLeadWorkflowContext, instantToAlmatyLocalDateTime, LEAD_NEXT_ACTION_LABELS, LEAD_NEXT_ACTIONS, type LeadWorkflowContext } from "@/core/lead-workflow";
import { requirePermissionAnd } from "@/server/dal";
import { loadLead, loadRequestCard } from "@/server/lead-data";
import { getPool } from "@/server/db";
import { legacyBridgeEnabled } from "@/server/bridge-client";
import { Icon } from "@/components/icon";
import { claimLeadAction, leadStatusAction, updateLeadWorkflowAction } from "../actions";
import { WorkflowActionForm } from "../workflow-action-form";

export const metadata: Metadata = { title: "Карточка заявки" };

const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят. Выберите другую комнату или время.",
  invalid: "Проверьте дату, слот, комнату и пакет (у пакета должна быть цена; прошедший слот занять нельзя).",
  conflict: "Заявка уже обработана.", forbidden: "Недостаточно прав.", stale_update: "Заявку уже изменил другой сотрудник. Обновите страницу и повторите действие.",
  lead_not_open: "План обработки можно менять только у новой заявки или заявки в работе.", lead_already_assigned: "Заявка уже назначена другому сотруднику.",
};
const NOTICES: Record<string, string> = { status: "Статус изменён.", workflow: "План обработки сохранён.", claimed: "Заявка назначена вам." };
const input = "crm-requests-control";
const btnGhost = "crm-requests-action crm-requests-action-secondary";
const panel = "rounded-2xl border border-line bg-white p-5 shadow-sm";

type Catalog = { packages: Awaited<ReturnType<typeof listPackages>>; rooms: Awaited<ReturnType<typeof listRooms>>; slots: Awaited<ReturnType<typeof listSlots>> };

/**
 * Request card on the current production contract: the list RPC (bridge) or the database (direct mode).
 * The record is read by id. Payments and refunds are deliberately absent: production has no supported operation for
 * them on this path; the recorded manual prepayment is shown read-only.
 */
export default async function RequestCardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const bridge = legacyBridgeEnabled();
  // Bridge mode: the record by id and the catalog are ONE round trip (`requests.card`) that starts together with the session check.
  const { session, data: card } = await requirePermissionAnd("requests.manage", () => loadRequestCard(id));
  const { user } = session;
  const actor = { id: user.id, role: user.role };
  let lead: NonNullable<Awaited<ReturnType<typeof loadLead>>> | null;
  let cat: Catalog;
  let workflowContext: LeadWorkflowContext;
  if (bridge) {
    lead = card?.lead ?? null;
    if (!lead || !card) notFound();
    cat = card.catalog;
    workflowContext = card.workflowContext;
  } else {
    lead = await loadLead(actor, id);
    if (!lead) notFound();
    const pool = getPool();
    const [packages, rooms, slots] = await Promise.all([listPackages(pool), listRooms(pool), listSlots(pool)]);
    cat = { packages, rooms, slots };
    workflowContext = await getLeadWorkflowContext(pool, actor, id);
  }
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Almaty" });
  const open = lead.status === "new" || lead.status === "in_progress";
  const pkg = cat.packages.find((p) => p.id === lead.packageId)?.name ?? "не выбран";
  const room = cat.rooms.find((r) => r.id === lead.roomId)?.name ?? "не выбрана";
  const actionTime = (value: Date | null) => value ? fmt.format(value) : "не запланировано";
  const auditSummary = (value: LeadWorkflowContext["history"][number]["after"]) => {
    const assigned = value.assigneeName ?? (value.assignedTo ? "Сотрудник" : "Не назначен");
    const next = value.nextAction ? `${LEAD_NEXT_ACTION_LABELS[value.nextAction]} · ${actionTime(value.followUpAt ? new Date(value.followUpAt) : null)}` : "Действий не запланировано";
    return `Ответственный: ${assigned}. ${next}.${value.agreementChanged ? " Договорённость обновлена." : ""}`;
  };

  return (
    <div className="crm-page crm-requests-page">
      <nav aria-label="Назад"><Link href="/requests" className="inline-flex min-h-11 items-center text-sm font-extrabold text-grape-700 underline md:min-h-0">← Все заявки</Link></nav>
      <header className="crm-requests-heading">
        <div>
          <p className="crm-eyebrow">Заявка №{lead.seq}</p>
          <h1 className="crm-page-title">{lead.name}</h1>
          <p className="crm-page-subtitle">Создана {fmt.format(lead.createdAt)} (Алматы)</p>
        </div>
        <span className="crm-requests-status" data-status={lead.status}>{STATUS[lead.status] ?? lead.status}</span>
      </header>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="crm-requests-message crm-requests-message-error">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <section className={panel} aria-labelledby="req-info">
        <h2 id="req-info" className="text-lg font-black text-grape-800">Данные заявки</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Телефон</dt><dd className="font-bold"><a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="crm-lead-phone"><Icon name="phone" size={15} /><span>{lead.phone}</span></a></dd></div>
          <div><dt className="text-muted">Желаемая дата</dt><dd className="font-bold">{lead.requestedDate ?? "не указана"}</dd></div>
          <div><dt className="text-muted">Пожелание по времени</dt><dd className="font-bold">{lead.preferredStartTime ?? "не указано"}</dd></div>
          <div><dt className="text-muted">Пакет</dt><dd className="font-bold">{pkg}</dd></div>
          <div><dt className="text-muted">Комната</dt><dd className="font-bold">{room}</dd></div>
          <div><dt className="text-muted">Детей</dt><dd className="font-bold">{lead.children ?? "—"}</dd></div>
          <div><dt className="text-muted">Предоплата</dt><dd className="font-bold">{lead.prepaymentKzt === null ? "не записана" : `${lead.prepaymentKzt.toLocaleString("ru-RU")} ₸ (ручная)`}</dd></div>
        </dl>
        {lead.reservationId ? <p className="mt-4 text-sm"><Link href={`/bookings?date=${lead.requestedDate}`} className="font-extrabold text-grape-700 underline">Показать бронь в календаре</Link></p> : null}
      </section>

      {open ? (
        <section className={panel} aria-labelledby="req-actions">
          <h2 id="req-actions" className="text-lg font-black text-grape-800">Действия</h2>
          <p className="mt-3 text-sm font-bold text-muted">Проверьте свободную комнату и завершите бронирование в календаре после отдельной фиксации реально полученной ручной предоплаты: <Link href={`/bookings?date=${lead.requestedDate}&continue=${encodeURIComponent(lead.id)}`} className="text-grape-700 underline" data-testid="continue-in-calendar">Открыть календарь</Link></p>
          <section className="crm-lead-workflow" aria-labelledby="lead-workflow-title">
            <h3 id="lead-workflow-title">Следующее действие</h3>
          <WorkflowActionForm key={lead.workflowVersion} action={updateLeadWorkflowAction} className="crm-lead-workflow-form">
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="expectedVersion" value={lead.workflowVersion} />
              <label>
                <span>Ответственный</span>
                <select name="assignedTo" defaultValue={lead.assignedTo ?? ""} className={input}>
                  <option value="">Не назначен</option>
                  {lead.assignedTo && !workflowContext.assignees.some((assignee) => assignee.id === lead.assignedTo) ? <option value={lead.assignedTo}>{lead.assigneeName ?? "Сотрудник"} (неактивен)</option> : null}
                  {workflowContext.assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}{assignee.id === user.id ? " (вы)" : ""}</option>)}
                </select>
              </label>
              <label>
                <span>Конкретная задача</span>
                <select name="nextAction" defaultValue={lead.nextAction ?? ""} className={input}>
                  <option value="">Не планировать</option>
                  {LEAD_NEXT_ACTIONS.map((action) => <option key={action} value={action}>{LEAD_NEXT_ACTION_LABELS[action]}</option>)}
                </select>
              </label>
              <label>
                <span>Связаться до (Алматы)</span>
                <input type="datetime-local" name="followUpAtLocal" defaultValue={instantToAlmatyLocalDateTime(lead.followUpAt)} className={input} />
              </label>
              <label className="crm-lead-workflow-agreement">
                <span>Договорённость с клиентом</span>
                <textarea name="managerAgreement" defaultValue={lead.managerAgreement ?? ""} maxLength={1000} rows={3} className={input} aria-describedby="lead-agreement-help" />
                <small id="lead-agreement-help" className="font-normal text-muted">Кратко зафиксируйте согласованный следующий шаг. Не записывайте платёжные реквизиты.</small>
              </label>
          </WorkflowActionForm>
            <p className="crm-requests-note">План сохраняется в CRM и журнале действий. Сообщения клиенту автоматически не отправляются.</p>
            {!lead.assignedTo ? <form action={claimLeadAction} className="crm-lead-claim-form">
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="expectedVersion" value={lead.workflowVersion} />
              <button type="submit" className={btnGhost}>Взять заявку себе</button>
            </form> : null}
          </section>
          <div className="mt-3 flex flex-wrap gap-2">
            {lead.status === "new" ? <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="in_progress" /><button type="submit" className={btnGhost}>В работу</button></form> : null}
            <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="cancelled" /><button type="submit" className={btnGhost}>Отклонить</button></form>
          </div>
        </section>
      ) : null}
      <section className={panel} aria-labelledby="lead-history-title">
        <h2 id="lead-history-title" className="text-lg font-black text-grape-800">История обработки</h2>
        {workflowContext.history.length ? <ol className="crm-lead-history">
          {workflowContext.history.map((event) => <li key={event.id}>
            <div><strong>{event.actorName ?? "Сотрудник"}</strong><time dateTime={event.at.toISOString()}>{fmt.format(event.at)}</time></div>
            <p>Было: {auditSummary(event.before)}</p>
            <p>Стало: {auditSummary(event.after)}</p>
          </li>)}
        </ol> : <p className="mt-3 text-sm text-muted">Действий по плану обработки пока нет.</p>}
      </section>
    </div>
  );
}
