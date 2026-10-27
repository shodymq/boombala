"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useStepUp } from "../step-up";

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
  totp_required: "Сначала включите второй фактор (приложение-аутентификатор): он остаётся запасным входом.",
  step_up_required: "Подтверждение личности истекло. Повторите.",
};

export interface Key {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

const fmt = (iso: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(iso));

/**
 * Adds / revokes this person's devices. Both need a FRESH proof of identity (step-up): the signed-in cookie alone cannot add an attacker's
 * device or remove the owner's.
 */
export function PasskeyManager({ keys, hasTotp }: { keys: Key[]; hasTotp: boolean }) {
  const router = useRouter();
  const [label, setLabel] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const step = useStepUp({ hasTotp, hasPasskey: keys.length > 0 });

  async function add() {
    if (busy) return;
    setMessage(null);
    if (!(await step.ask("passkey_register"))) return;
    setBusy(true);
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

  async function revoke(id: string) {
    if (busy) return;
    setMessage(null);
    if (!(await step.ask("passkey_revoke"))) return;
    setBusy(true);
    try {
      const r = await fetch("/api/webauthn/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.ok) {
        setMessage({ ok: true, text: "Ключ отозван: с этого устройства войти им больше нельзя." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error === "last_factor" ? "Нельзя отозвать последний способ входа без запасного. Сначала включите приложение-аутентификатор." : (ERRORS[result.error] ?? "Не удалось отозвать ключ.") });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {keys.length === 0 ? <p className="text-sm text-muted" data-testid="passkey-empty">Устройств пока нет.</p> : null}
      <ul className="grid gap-2" data-testid="passkey-list">
        {keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line p-3">
            <div className="min-w-0">
              <p className="font-black text-grape-900 [overflow-wrap:anywhere]">{k.label}</p>
              <p className="text-xs text-muted">
                Добавлено {fmt(k.createdAt)} · {k.lastUsedAt ? `вход: ${fmt(k.lastUsedAt)}` : "ещё не использовался"}
                {k.backedUp ? " · синхронизируется (iCloud/Google)" : ""}
              </p>
            </div>
            <button type="button" onClick={() => revoke(k.id)} disabled={busy} className="h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-60">Отозвать</button>
          </li>
        ))}
      </ul>
      {step.panel}
      <div className="flex flex-wrap gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="Название устройства" placeholder="Название устройства" className={input} />
        <button type="button" onClick={add} disabled={busy || !label.trim()} data-testid="passkey-add" className="h-12 rounded-full bg-grape-700 px-6 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">
          {busy ? "Подождите…" : "Добавить это устройство"}
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
