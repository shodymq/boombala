"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button for the calendar's server-action forms. While the action runs it is disabled, so a second click cannot send
 * the command twice; the form's idempotency key protects against a resend after a reload as well.
 */
export function SubmitButton({ children, pending: pendingText = "Сохраняем…", className }: { children: React.ReactNode; pending?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending ? pendingText : children}
    </button>
  );
}
