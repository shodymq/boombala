"use client";

import { useActionState, useLayoutEffect, useRef, type ReactNode } from "react";
import { restoreFormValues, snapshotFormValues, type FormValueSnapshot } from "@/components/preserve-form-values";

export type LeadWorkflowFormState = { errorCode: string } | null;
export type LeadWorkflowFormAction = (state: LeadWorkflowFormState, formData: FormData) => Promise<LeadWorkflowFormState>;

const MESSAGES: Record<string, string> = {
  stale_update: "Другой сотрудник обновил эту заявку. Ваши значения сохранены; обновите страницу и согласуйте изменения.",
  lead_already_assigned: "Заявка уже назначена другому сотруднику. Ваши значения сохранены.",
  lead_not_open: "План обработки можно менять только у новой заявки или заявки в работе.",
  invalid: "Проверьте поля плана обработки. Введённые значения сохранены.",
  forbidden: "Недостаточно прав для изменения плана.",
  fastapi_unavailable: "Сервис временно недоступен. Введённые значения сохранены.",
};

export function WorkflowActionForm({ action, children, className }: { action: LeadWorkflowFormAction; children: ReactNode; className: string }) {
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
      data-lead-workflow-form
    >
      {children}
      {state ? <p role="alert" className="crm-requests-message crm-requests-message-error" data-workflow-error={state.errorCode}>{MESSAGES[state.errorCode] ?? "Не удалось сохранить план. Введённые значения сохранены."}</p> : null}
      <button type="submit" disabled={pending} className="crm-requests-action" aria-busy={pending}>{pending ? "Сохраняем…" : "Сохранить план"}</button>
    </form>
  );
}
