"use client";

import { useActionState, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { restoreFormValues, snapshotFormValues, type FormValueSnapshot } from "@/components/preserve-form-values";
import type { BookingFormAction } from "./booking-action-state";

const ERROR_TEXT: Record<string, string> = {
  invalid: "Проверьте введённые данные. Поля остались заполненными.",
  conflict: "Запись изменилась в другой сессии. Обновите карточку и повторите действие; введённые данные сохранены.",
  card_version_conflict: "Другой сотрудник изменил карточку. Обновите страницу и согласуйте изменения; ваши значения сохранены.",
  time_conflict: "Комната занята в это время. Предыдущая бронь не изменена; проверьте расписание и выберите другое время.",
  slot_taken: "Комната уже занята. Данные формы сохранены; обновите расписание.",
  outside_working_hours: "Время выходит за часы работы филиала. Данные формы сохранены.",
  branch_hours_unknown: "Часы работы филиала не распознаны. Данные формы сохранены.",
  start_in_past: "Нельзя занять прошедшее время. Данные формы сохранены.",
  unavailable: "Система бронирования временно недоступна. Данные формы сохранены; повторите позже.",
  forbidden: "Недостаточно прав для этого действия.",
  payment_confirmation_required: "Подтвердите, что деньги действительно получены; запись факта не выполнена.",
  payment_amount_mismatch: "Сумма предоплаты должна быть ровно 10 000 ₸; платёжный факт не записан.",
  payment_unverified: "Система не подтвердила платёжный факт. Обновите заявку и проверьте оплату перед повтором.",
  birthday_prepayment_required: "Backend не подтвердил предоплату; бронь не создана.",
  birthday_request_not_payable: "Нельзя фиксировать предоплату для закрытой заявки.",
  birthday_request_not_bookable: "Эту заявку нельзя подтвердить. Обновите её статус.",
  request_already_booked: "Заявка уже связана с подтверждённой бронью.",
  idempotency_conflict: "Параллельное действие уже изменило эту заявку. Обновите страницу и проверьте её состояние.",
  reservation_already_released: "Запись уже освобождена. Обновите календарь.",
  program_incomplete: "Программу нельзя согласовать, пока не выбраны все включённые позиции. Введённые значения сохранены.",
};

export function BookingActionForm({
  action,
  children,
  className,
  label,
  dataTestId,
}: {
  action: BookingFormAction;
  children: ReactNode;
  className: string;
  label: string;
  dataTestId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const submittedValues = useRef<FormValueSnapshot>([]);
  useLayoutEffect(() => {
    if (state && formRef.current) restoreFormValues(formRef.current, submittedValues.current);
  }, [state]);
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => { submittedValues.current = snapshotFormValues(event.currentTarget); }}
      className={className}
      aria-label={label}
      data-preserve-on-error
      data-testid={dataTestId}
    >
      <fieldset disabled={pending} className="m-0 grid min-w-0 gap-[inherit] border-0 p-0">
        {children}
      </fieldset>
      {state ? (
        <div role="alert" className="grid gap-2 rounded-xl bg-sun-100 p-3 text-sm font-bold text-grape-900" data-booking-action-error={state.errorCode}>
          <p>{ERROR_TEXT[state.errorCode] ?? "Не удалось выполнить действие. Данные формы сохранены; проверьте календарь."}</p>
          {state.requestId ? <Link href={`/requests/${encodeURIComponent(state.requestId)}`} className="w-fit min-h-11 text-grape-800 underline underline-offset-2">Открыть связанную заявку</Link> : null}
        </div>
      ) : null}
      {pending ? <p role="status" aria-live="polite" className="text-sm font-bold text-muted">Сохраняем изменения…</p> : null}
    </form>
  );
}
