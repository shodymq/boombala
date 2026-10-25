"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useRef, useState, type ReactNode } from "react";

export type StepUpPurpose = "passkey_register" | "passkey_revoke" | "passkeys_revoke_all" | "enrollment_code";

const TITLES: Record<StepUpPurpose, string> = {
  passkey_register: "Чтобы добавить устройство, подтвердите, что это вы.",
  passkey_revoke: "Чтобы отозвать ключ, подтвердите, что это вы.",
  passkeys_revoke_all: "Чтобы отозвать все ключи сотрудника, подтвердите, что это вы.",
  enrollment_code: "Чтобы выдать код настройки, подтвердите, что это вы.",
};

const field = "h-12 min-w-0 flex-1 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none";

/**
 * A fresh proof of identity before a sensitive action (step-up). A signed-in session alone is not enough: the person types a current code from
 * the authenticator app (or a recovery code), or confirms with a passkey they already have. The server records the proof for this session,
 * this purpose and a few minutes, and the action itself checks it.
 */
export function useStepUp(opts: { hasTotp: boolean; hasPasskey: boolean }) {
  const [purpose, setPurpose] = useState<StepUpPurpose | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = (p: StepUpPurpose) =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPurpose(p);
    });
  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPurpose(null);
  };
  const panel: ReactNode = purpose ? <Panel purpose={purpose} hasTotp={opts.hasTotp} hasPasskey={opts.hasPasskey} onDone={finish} /> : null;
  return { ask, panel };
}

function Panel({ purpose, hasTotp, hasPasskey, onDone }: { purpose: StepUpPurpose; hasTotp: boolean; hasPasskey: boolean; onDone: (ok: boolean) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const fail = (status: number) => setError(status === 429 ? "Слишком много попыток. Подождите несколько минут." : status === 401 ? "Сессия истекла. Войдите заново." : "Не подошло. Проверьте код и повторите.");

  async function withCode() {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await post("/api/auth/stepup", { purpose, code });
      if (r.ok) return onDone(true);
      fail(r.status);
    } catch {
      setError("Не удалось проверить. Повторите.");
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const o = await post("/api/webauthn/stepup/options", {});
      const options = await o.json().catch(() => ({}));
      if (!o.ok || !options.ok) return fail(o.status);
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options.options });
      } catch {
        setError("Подтверждение отменено.");
        return;
      }
      const v = await post("/api/webauthn/stepup/verify", { response, purpose });
      if (v.ok) return onDone(true);
      fail(v.status);
    } catch {
      setError("Не удалось проверить. Повторите.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Подтверждение личности" data-testid="stepup" className="grid gap-3 rounded-3xl border-2 border-grape-300 bg-grape-50 p-4">
      <p className="text-sm font-bold text-grape-900">{TITLES[purpose]}</p>
      {hasPasskey ? (
        <button type="button" onClick={withPasskey} disabled={busy} data-testid="stepup-passkey" className="h-12 rounded-full border-2 border-grape-700 text-base font-extrabold text-grape-700 hover:bg-white disabled:opacity-60">
          Подтвердить Face ID / Touch ID
        </button>
      ) : null}
      {hasTotp ? (
        <div className="flex flex-wrap gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && withCode()} inputMode="text" autoComplete="one-time-code" maxLength={40} aria-label="Код из приложения-аутентификатора или код восстановления" placeholder="Код из приложения или код восстановления" data-testid="stepup-code" className={field} />
          <button type="button" onClick={withCode} disabled={busy || !code.trim()} data-testid="stepup-submit" className="h-12 rounded-full bg-grape-700 px-6 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">
            Подтвердить
          </button>
        </div>
      ) : null}
      {!hasTotp && !hasPasskey ? <p className="text-sm text-muted">Нет способа подтверждения. Обратитесь к владельцу.</p> : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">{error}</p> : null}
      <button type="button" onClick={() => onDone(false)} className="justify-self-start text-sm font-extrabold text-grape-700 underline">Отмена</button>
    </div>
  );
}
