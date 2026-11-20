import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { BookingCardView } from "../../../core/booking-card.ts";
import type { OptionKind, PricingGap } from "../../../core/booking-pricing.ts";
import { handoverAction, saveCardAction } from "./crm-actions";
import { Drawer } from "./booking-drawer";
import { SubmitButton } from "./submit-button";

const kzt = new Intl.NumberFormat("ru-RU");
const field = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const area = "min-h-20 w-full rounded-xl border-2 border-grape-200 bg-white p-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const label = "grid gap-1 text-xs font-extrabold text-muted";
const primary = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-50";
const ghost = "flex h-11 items-center justify-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-50";

const KIND_TITLE: Record<OptionKind, string> = { show: "Шоу", master_class: "Мастер-класс", challenge: "Челлендж", animation: "Анимационная программа" };

export const CARD_ERRORS: Record<string, string> = {
  card_version_conflict: "Карточку уже изменил другой менеджер. Ваши правки не сохранены: ниже актуальные данные, внесите изменения заново.",
  program_incomplete: "Программу нельзя согласовать: выбраны не все включённые в пакет активности. Снимите отметку или завершите выбор.",
  program_option_not_allowed: "Этого варианта нет в выбранном пакете, либо выбрано больше, чем входит, либо один вариант выбран дважды.",
  program_needs_package: "У этого события нет пакета, программу согласовать нельзя.",
  invitation_not_applicable: "Онлайн-приглашение входит только в Boom Bala Party.",
  responsible_invalid: "Ответственным может быть только активный менеджер или владелец.",
  reservation_already_released: "Бронь уже отменена, карточка доступна только для чтения.",
  not_sheet_managed: "Эта запись не импортирована из таблицы.",
  already_handed_over: "Запись уже передана в CRM.",
  source_managed_read_only: "Запись управляется таблицей «Банкеты».",
  invalid: "Проверьте введённые значения (возраст, количество, суммы).",
  forbidden: "Недостаточно прав для этого действия.",
  unavailable: "Система бронирования временно недоступна. Ничего не сохранено.",
  failed: "Не удалось сохранить. Обновите страницу и повторите.",
};

const GAP_TEXT: Record<PricingGap, string> = {
  base_price_missing: "нет согласованной цены пакета",
  terms_missing: "для пакета нет условий V4.2 (например, архивный пакет): доплаты согласуйте вручную",
  headcount_by_fact: "состав «по факту»: доплаты определяются по факту",
  headcount_missing: "не указано количество детей или взрослых",
  child_tariff_missing: "тариф входа дополнительных детей ещё не утверждён: укажите согласованную сумму",
  adult_tariff_missing: "тариф входа взрослых ещё не утверждён: укажите согласованную сумму",
};

const ACTION_TEXT: Record<string, string> = {
  created: "Карточка создана",
  updated: "Изменено",
  program_approved: "Программа согласована",
  program_reopened: "Согласование программы снято",
  rescheduled: "Бронь перенесена",
  prepayment_recorded: "Предоплата записана",
  cancelled: "Бронь отменена",
  handed_over: "Запись передана в CRM",
};

const FIELD_TEXT: Record<string, string> = {
  preferredLanguage: "язык", childName: "именинник", childAge: "возраст", headcountMode: "режим состава", childrenTotal: "детей", adultsTotal: "взрослых",
  responsibleUserId: "ответственный", animationNote: "анимация", wishes: "пожелания", decoration: "оформление", cake: "торт", staffComment: "комментарий",
  programStatus: "согласование программы", propsStatus: "реквизит", invitationStatus: "приглашение", manualExtraChildrenKzt: "доплата за детей", manualExtraAdultsKzt: "доплата за взрослых",
  mealKzt: "питание", animators: "аниматоры", services: "услуги", selections: "программа", totalKzt: "итог",
};

const PROPS_TEXT = { not_started: "не начата", preparing: "готовится", ready: "готов" } as const;
const INVITATION_TEXT = { not_started: "не начато", in_progress: "в работе", sent: "отправлено" } as const;

function Money({ value }: { value: number | null }) {
  return <>{value === null ? "—" : `${kzt.format(value)} ₸`}</>;
}

function Line({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-line py-1 text-sm">
      <dt className="font-extrabold text-muted">{term}</dt>
      <dd className="min-w-0 break-words font-bold text-grape-900">{children}</dd>
    </div>
  );
}

function when(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/**
 * The booking card (Booking V2). Server-rendered and driven by the address, like the rest of the calendar. The program choices
 * come from the package's versioned rules; the amount shown is what the server calculated, never a figure the browser sends.
 */
export function BookingCardPanel({ view, branchId, date, closeHref, backHref, saved, error, sourceManaged, handedOver }: {
  view: BookingCardView;
  branchId: string;
  date: string;
  closeHref: string;
  backHref: string;
  saved?: string;
  error?: string;
  sourceManaged: boolean;
  handedOver: boolean;
}) {
  const f = view.fields;
  const terms = view.terms;
  const editable = !view.released && !sourceManaged;
  const nameOf = (id: string) => view.optionNames.find((o) => o.id === id)?.nameRu ?? id;
  const services = [...f.services];
  while (services.length < Math.max(3, f.services.length + 1)) services.push({ name: "", amountKzt: 0 });
  const chosen = (kind: OptionKind) => f.selections.filter((s) => s.kind === kind).map((s) => s.optionId);
  const errorText = error ? CARD_ERRORS[error] ?? CARD_ERRORS.failed : null;

  return (
    <Drawer title={view.kind === "block" ? "Карточка мероприятия" : "Карточка брони"} closeHref={closeHref} wide>
      {saved ? <p role="status" className="mb-2 rounded-xl bg-green-100 p-2 text-sm font-bold text-grape-900">{saved === "handover" ? "Запись передана в CRM." : "Карточка сохранена."}</p> : null}
      {errorText ? <p role="alert" className="mb-2 rounded-xl bg-sun-100 p-2 text-sm font-bold text-grape-900">{errorText}</p> : null}
      <dl data-booking-card={view.reservationId}>
        <Line term="Клиент">{view.customer.name ?? "—"}{view.customer.phone ? ` · ${view.customer.phone}` : ""}</Line>
        <Line term="Пакет">{view.packageId ? `${view.packageName ?? view.packageId}${view.termsVersion ? ` · условия ${view.termsVersion}` : " · архивный пакет"}` : "не указан"}</Line>
        <Line term="Создал">{view.createdByName ?? "—"}</Line>
        <Line term="Ответственный">{view.responsibleName ?? "не назначен"}</Line>
        <Line term="Последнее изменение">{view.updatedByName ? `${view.updatedByName}${view.updatedAt ? `, ${when(view.updatedAt)}` : ""}` : "—"}</Line>
        <Line term="Статусы">{view.released ? "бронь снята" : "бронь подтверждена"} · программа: {f.programStatus === "approved" ? "согласована" : "не согласована"} · реквизит: {PROPS_TEXT[f.propsStatus]}{terms?.onlineInvitation ? ` · приглашение: ${f.invitationStatus === "not_applicable" ? "—" : INVITATION_TEXT[f.invitationStatus]}` : ""}</Line>
      </dl>

      {sourceManaged ? (
        <p className="mt-3 rounded-xl bg-paper p-2 text-xs text-muted">Эта запись управляется таблицей «Банкеты»: время, комната и отмена меняются в таблице. Чтобы вести её в CRM, передайте управление: синхронизация перестанет её менять.</p>
      ) : null}
      {sourceManaged ? (
        <form action={handoverAction} className="mt-2" aria-label="Передать запись в CRM">
          <input type="hidden" name="branchId" value={branchId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="reservationId" value={view.reservationId} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <SubmitButton className={ghost} pending="Передаём…">Передать управление в CRM</SubmitButton>
        </form>
      ) : null}
      {handedOver ? <p className="mt-3 rounded-xl bg-paper p-2 text-xs text-muted">Запись передана из таблицы в CRM: синхронизация её больше не меняет.</p> : null}

      <form action={saveCardAction} className="mt-4 grid gap-3" aria-label="Карточка брони" data-testid="booking-card-form">
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="reservationId" value={view.reservationId} />
        <input type="hidden" name="expectedVersion" value={view.version ?? ""} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <fieldset disabled={!editable} className="grid min-w-0 gap-3">
          <h3 className="text-sm font-black text-grape-800">Именинник и семья</h3>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <label className={label}>Имя именинника<input name="childName" maxLength={80} defaultValue={f.childName ?? ""} className={field} /></label>
            <label className={label}>Возраст<input name="childAge" type="number" min={0} max={99} defaultValue={f.childAge ?? ""} className={field} /></label>
          </div>
          <label className={label}>Язык общения
            <select name="preferredLanguage" defaultValue={f.preferredLanguage ?? ""} className={field}>
              <option value="">не указан</option><option value="ru">Русский</option><option value="kk">Қазақша</option>
            </select>
          </label>
          <label className={label}>Ответственный менеджер
            <select name="responsibleUserId" defaultValue={f.responsibleUserId ?? ""} className={field}>
              <option value="">не назначен</option>
              {view.staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          <h3 className="text-sm font-black text-grape-800">Состав гостей{terms ? ` (в пакет входит: детей ${terms.includedChildren}, взрослых ${terms.includedAdults})` : ""}</h3>
          <div className="flex flex-wrap gap-4 text-sm font-bold text-grape-900">
            <label className="flex items-center gap-2"><input type="radio" name="headcountMode" value="exact" defaultChecked={f.headcountMode === "exact"} /> Точное количество</label>
            <label className="flex items-center gap-2"><input type="radio" name="headcountMode" value="by_fact" defaultChecked={f.headcountMode === "by_fact"} /> По факту</label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className={label}>Детей (с именинником)<input name="childrenTotal" type="number" min={0} max={200} defaultValue={f.childrenTotal ?? ""} className={field} /></label>
            <label className={label}>Взрослых<input name="adultsTotal" type="number" min={0} max={200} defaultValue={f.adultsTotal ?? ""} className={field} /></label>
          </div>
          <label className={label}>Аниматоры или персонажи (через запятую{terms ? `, по пакету: ${terms.animators}` : ""})<input name="animators" maxLength={400} defaultValue={f.animators.join(", ")} className={field} /></label>

          {terms ? (
            <>
              <h3 className="text-sm font-black text-grape-800">Программа праздника ({terms.programMinutes} мин)</h3>
              <p className="text-xs text-muted">Можно заполнять постепенно. Отметка «Программа согласована» проверяется сервером: все включённые в пакет выборы должны быть сделаны.</p>
              {terms.rules.map((rule) => rule.pickCount === 0 ? (
                <label key={rule.kind} className={label}>{KIND_TITLE[rule.kind]} — отдельный блок {rule.minutes} мин, сценарий согласуется с организатором
                  <input name="animationNote" maxLength={300} defaultValue={f.animationNote ?? ""} className={field} />
                </label>
              ) : (
                <fieldset key={rule.kind} className="grid gap-1 rounded-xl border border-line p-2" data-program-kind={rule.kind}>
                  <legend className="px-1 text-xs font-extrabold text-muted">{KIND_TITLE[rule.kind]}: {rule.pickCount === 1 ? "1 на выбор" : `${rule.pickCount} из ${rule.options.length}`} · {rule.minutes} мин</legend>
                  {rule.options.map((optionId) => (
                    <label key={optionId} className="flex min-h-9 items-center gap-2 text-sm font-bold text-grape-900">
                      <input type={rule.pickCount === 1 ? "radio" : "checkbox"} name={`sel_${rule.kind}`} value={optionId} defaultChecked={chosen(rule.kind).includes(optionId)} />
                      {nameOf(optionId)}
                    </label>
                  ))}
                </fieldset>
              ))}
              {terms.rules.every((r) => r.kind !== "animation" || r.pickCount > 0) ? <input type="hidden" name="animationNote" value={f.animationNote ?? ""} /> : null}
              <label className="flex min-h-9 items-center gap-2 text-sm font-extrabold text-grape-900"><input type="checkbox" name="programApproved" defaultChecked={f.programStatus === "approved"} /> Программа согласована</label>
            </>
          ) : (
            <p className="rounded-xl bg-paper p-2 text-xs text-muted">У события нет пакета Pricing V4.2, выбор программы недоступен.</p>
          )}

          <h3 className="text-sm font-black text-grape-800">Подготовка</h3>
          <label className={label}>Реквизит
            <select name="propsStatus" defaultValue={f.propsStatus} className={field}>
              {Object.entries(PROPS_TEXT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {terms?.onlineInvitation ? (
            <label className={label}>Онлайн-приглашение (Boom Bala)
              <select name="invitationStatus" defaultValue={f.invitationStatus === "not_applicable" ? "not_started" : f.invitationStatus} className={field}>
                {Object.entries(INVITATION_TEXT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          ) : null}
          <label className={label}>Оформление<input name="decoration" maxLength={300} defaultValue={f.decoration ?? ""} className={field} /></label>
          <label className={label}>Торт (торт в стоимость пакета не входит)<input name="cake" maxLength={300} defaultValue={f.cake ?? ""} className={field} /></label>
          <label className={label}>Пожелания клиента<textarea name="wishes" maxLength={1000} defaultValue={f.wishes ?? ""} className={area} /></label>
          <label className={label}>Комментарий сотрудников<textarea name="staffComment" maxLength={1000} defaultValue={f.staffComment ?? ""} className={area} /></label>

          <h3 className="text-sm font-black text-grape-800">Дополнительные услуги и питание</h3>
          {services.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem] gap-2">
              <input name={`svcName${i}`} maxLength={80} placeholder="Услуга" aria-label={`Услуга ${i + 1}`} defaultValue={s.name} className={field} />
              <input name={`svcAmount${i}`} type="number" min={1} max={10000000} placeholder="₸" aria-label={`Сумма услуги ${i + 1}`} defaultValue={s.amountKzt || ""} className={field} />
            </div>
          ))}
          <label className={label}>Питание (согласованная сумма, ₸)<input name="mealKzt" type="number" min={0} max={10000000} defaultValue={f.mealKzt || ""} className={field} /></label>

          <h3 className="text-sm font-black text-grape-800">Доплаты, согласованные менеджером</h3>
          <p className="text-xs text-muted">Заполняйте, если тариф ещё не утверждён или состав «по факту». Скидка 20% относится только к входу дополнительных детей.</p>
          <div className="grid grid-cols-2 gap-2">
            <label className={label}>Доплата за детей, ₸<input name="manualExtraChildrenKzt" type="number" min={0} max={10000000} defaultValue={f.manualExtraChildrenKzt ?? ""} className={field} /></label>
            <label className={label}>Доплата за взрослых, ₸<input name="manualExtraAdultsKzt" type="number" min={0} max={10000000} defaultValue={f.manualExtraAdultsKzt ?? ""} className={field} /></label>
          </div>
        </fieldset>

        <dl className="rounded-2xl bg-grape-50 p-3" data-card-money>
          <Line term="Пакет (согласован)"><Money value={view.baseKzt} /></Line>
          <Line term="Доп. дети">{view.pricing.extraChildren !== null ? `${view.pricing.extraChildren} · ` : ""}<Money value={view.pricing.extraChildrenKzt} /></Line>
          <Line term="Доп. взрослые">{view.pricing.extraAdults !== null ? `${view.pricing.extraAdults} · ` : ""}<Money value={view.pricing.extraAdultsKzt} /></Line>
          <Line term="Услуги"><Money value={view.pricing.servicesKzt} /></Line>
          <Line term="Питание"><Money value={view.pricing.mealKzt} /></Line>
          <Line term="Итого"><span data-card-total>{view.pricing.totalKzt === null ? "не рассчитано" : <Money value={view.pricing.totalKzt} />}</span></Line>
          <Line term="Предоплата">{view.paidKzt > 0 ? `${kzt.format(view.paidKzt)} ₸ (записана вручную, не онлайн-оплата)` : "не записана"}</Line>
          <Line term="Остаток"><span data-card-remaining>{view.remainingKzt === null ? "неизвестен: расчёт неполный" : <Money value={view.remainingKzt} />}</span></Line>
          {view.pricing.status === "incomplete" ? (
            <p role="status" className="mt-2 text-xs font-bold text-grape-900" data-pricing-incomplete>Расчёт неполный: {view.pricing.gaps.map((g) => GAP_TEXT[g]).join("; ")}.</p>
          ) : null}
        </dl>

        {editable ? (
          <div className="flex gap-2">
            <SubmitButton className={primary} pending="Сохраняем…">Сохранить карточку</SubmitButton>
            <Link href={backHref} scroll={false} className={ghost}>К брони</Link>
          </div>
        ) : <Link href={backHref} scroll={false} className={ghost}>К брони</Link>}
      </form>

      <section aria-label="История изменений" className="mt-5">
        <h3 className="text-sm font-black text-grape-800">История события</h3>
        {view.history.length === 0 ? <p className="text-xs text-muted">Записей пока нет.</p> : (
          <ol className="mt-1 grid gap-1 text-xs" data-card-history>
            {view.history.map((h) => (
              <li key={h.id} className="rounded-lg border border-line p-2">
                <span className="font-extrabold text-grape-900">{ACTION_TEXT[h.action] ?? h.action}</span> · {h.actorName ?? "система"} · {when(h.at)}
                {h.action === "updated" ? <span className="block text-muted">{Object.keys(h.changes).map((k) => FIELD_TEXT[k] ?? k).join(", ")}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Drawer>
  );
}
