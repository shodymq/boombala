"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

const MESSAGES: Record<string, string> = {
  locked: "Слишком много неудачных попыток. Повторите через несколько минут.",
  invalid: "Не удалось войти с этим ключом. Войдите по паролю и коду или добавьте ключ в разделе «Мой доступ».",
  generic: "Не удалось войти с помощью Face ID / Touch ID. Можно войти по паролю.",
};

/** «Войти с Face ID / Touch ID»: a passkey with user verification replaces the password AND the code. Needs a tap (a user gesture) on iPhone. */
export function PasskeyLogin({ pending = false }: { pending?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const o = await fetch("/api/webauthn/login/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const options = await o.json().catch(() => ({}));
      if (!o.ok || !options.ok) {
        setError(o.status === 429 ? MESSAGES.locked : MESSAGES.generic);
        return;
      }
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options.options });
      } catch {
        // cancelled or unsupported: no scary message, the password stays available
        setError("Вход отменён. Можно повторить или войти по паролю.");
        return;
      }
      const v = await fetch("/api/webauthn/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }) });
      const result = await v.json().catch(() => ({}));
      if (v.ok && result.ok) {
        // a full navigation on purpose: the response carried the new session cookie and the whole page must be rendered with it
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/";
        return;
      }
      setError(v.status === 429 ? MESSAGES.locked : MESSAGES.invalid);
    } catch {
      setError(MESSAGES.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 grid gap-2 border-t border-line pt-5">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        data-testid="passkey-login"
        className="h-12 rounded-full border-2 border-grape-700 text-base font-extrabold text-grape-700 transition-colors hover:bg-grape-50 disabled:opacity-60"
      >
        {busy ? "Подтвердите на устройстве…" : pending ? "Подтвердить Face ID / Touch ID" : "Войти с Face ID / Touch ID"}
      </button>
      {error ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">
          {error}
        </p>
      ) : null}
    </div>
  );
}
