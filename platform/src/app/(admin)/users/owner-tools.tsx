"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useStepUp } from "../step-up";

const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-60";

/**
 * The Owner's tools for one person: issue a one-time enrolment code (a new employee, or after a reset) and revoke all of their keys.
 * Both need the Owner's fresh step-up. The code is shown ONCE and is never stored in clear.
 */
export function OwnerTools({ userId, name, canIssueCode, keyCount, hasTotp, ownHasPasskey }: { userId: string; name: string; canIssueCode: boolean; keyCount: number; hasTotp: boolean; ownHasPasskey: boolean }) {
  const router = useRouter();
  const step = useStepUp({ hasTotp, hasPasskey: ownHasPasskey });
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ value: string; until: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function issue() {
    if (busy) return;
    setMessage(null);
    if (!(await step.ask("enrollment_code"))) return;
    setBusy(true);
    try {
      const r = await fetch("/api/auth/enrollment-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.ok) setCode({ value: result.code, until: new Intl.DateTimeFormat("ru-RU", { timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(result.expiresAt)) });
      else setMessage({ ok: false, text: result.error === "already_enrolled" ? "У сотрудника уже есть способ входа. Чтобы выдать код, сначала сбросьте его второй фактор." : "Не удалось выдать код." });
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    if (busy) return;
    setMessage(null);
    if (!(await step.ask("passkeys_revoke_all"))) return;
    setBusy(true);
    try {
      const r = await fetch("/api/webauthn/revoke-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.ok) {
        setMessage({ ok: true, text: "Ключи Face ID / Touch ID отозваны, сессии сотрудника завершены. Он войдёт по паролю и коду." });
        router.refresh();
      } else setMessage({ ok: false, text: "Не удалось отозвать ключи." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-2" data-testid={`owner-tools-${userId}`}>
      <div className="flex flex-wrap items-center gap-2">
        {keyCount > 0 ? <span className="text-sm text-muted">Face ID / Touch ID: {keyCount} устр.</span> : <span className="text-sm text-muted">Face ID / Touch ID: не добавлен</span>}
        {keyCount > 0 ? <button type="button" onClick={revokeAll} disabled={busy} className={btnGhost} data-testid="revoke-all">Отозвать все ключи</button> : null}
        {canIssueCode ? <button type="button" onClick={issue} disabled={busy} className={btnGhost} data-testid="issue-code">Выдать код настройки</button> : null}
      </div>
      {step.panel}
      {code ? (
        <div role="status" className="grid gap-1 rounded-2xl bg-grape-100 p-3" data-testid="enrollment-code">
          <p className="text-sm font-bold text-grape-900">Код настройки для {name} (показан один раз, действует до {code.until}):</p>
          <p className="font-mono text-2xl font-black tracking-wider text-grape-900" data-testid="enrollment-code-value">{code.value}</p>
          <p className="text-xs text-muted">Передайте лично. После пароля сотрудник вводит этот код и включает второй фактор.</p>
        </div>
      ) : null}
      {message ? <p role={message.ok ? "status" : "alert"} className={`rounded-2xl p-3 text-sm font-bold ${message.ok ? "bg-grape-100" : "bg-sun-100"} text-grape-900`}>{message.text}</p> : null}
    </div>
  );
}
