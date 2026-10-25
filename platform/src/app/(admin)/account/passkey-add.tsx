"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "h-12 min-w-0 flex-1 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none";

function suggestedName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Моё устройство";
}

const ERRORS: Record<string, string> = {
  too_many_passkeys: "Достигнут предел: 10 ключей. Отзовите ненужные.",
  passkey_exists: "Это устройство уже добавлено.",
  validation: "Не удалось проверить ключ. Повторите.",
  too_many_challenges: "Слишком много попыток. Подождите минуту.",
};

/** Adds this device (Face ID / Touch ID / device PIN). Needs a tap: browsers refuse to open the prompt without a user gesture. */
export function PasskeyAdd() {
  const router = useRouter();
  const [label, setLabel] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function add() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const o = await fetch("/api/webauthn/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const opts = await o.json().catch(() => ({}));
      if (!o.ok || !opts.ok) {
        setMessage({ ok: false, text: ERRORS[opts.error] ?? "Не удалось начать. Повторите." });
        return;
      }
      let response;
      try {
        response = await startRegistration({ optionsJSON: opts.options });
      } catch {
        setMessage({ ok: false, text: "Добавление отменено. Можно повторить." });
        return;
      }
      const v = await fetch("/api/webauthn/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response, label }) });
      const result = await v.json().catch(() => ({}));
      if (v.ok && result.ok) {
        setMessage({ ok: true, text: "Устройство добавлено. Теперь можно входить через Face ID / Touch ID." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: ERRORS[result.error] ?? "Не удалось добавить устройство." });
      }
    } catch {
      setMessage({ ok: false, text: "Не удалось добавить устройство." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="Название устройства" placeholder="Название устройства" className={input} />
        <button type="button" onClick={add} disabled={busy || !label.trim()} data-testid="passkey-add" className="h-12 rounded-full bg-grape-700 px-6 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">
          {busy ? "Подтвердите на устройстве…" : "Добавить это устройство"}
        </button>
      </div>
      {message ? (
        <p role={message.ok ? "status" : "alert"} className={`rounded-2xl p-3 text-sm font-bold ${message.ok ? "bg-grape-100 text-grape-900" : "bg-sun-100 text-grape-900"}`} data-testid="passkey-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
