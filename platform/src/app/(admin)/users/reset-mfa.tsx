"use client";

import { useRef } from "react";
import { useStepUp } from "../step-up";
import { resetMfaAction } from "./actions";

const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-60";

/**
 * Resetting another person's second factor. The Owner first confirms who they are (step-up, purpose `mfa_reset`); only then does the form
 * submit. The server checks the same grant again inside the reset's transaction, so this button is a convenience, not the guard.
 */
export function MfaResetButton({ userId, hasTotp, ownHasPasskey }: { userId: string; hasTotp: boolean; ownHasPasskey: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const step = useStepUp({ hasTotp, hasPasskey: ownHasPasskey });

  async function confirmAndReset() {
    if (await step.ask("mfa_reset")) formRef.current?.requestSubmit();
  }

  return (
    <>
      <form ref={formRef} action={resetMfaAction}>
        <input type="hidden" name="id" value={userId} />
      </form>
      <button type="button" onClick={confirmAndReset} className={btnGhost} data-testid="reset-mfa">
        Сбросить второй фактор
      </button>
      {step.panel}
    </>
  );
}
