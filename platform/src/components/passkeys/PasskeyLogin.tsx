"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

type Options =
  | { mode: "authenticate"; options: PublicKeyCredentialRequestOptionsJSON }
  | { mode: "register"; options: PublicKeyCredentialCreationOptionsJSON };

export function PasskeyLogin() {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("Это устройство");
  const router = useRouter();

  useEffect(() => {
    let active = true;
    fetch("/api/auth/passkey/login/options", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as Options | { error?: string } | null;
        if (!response.ok || !body || !("mode" in body)) throw new Error("Не удалось подготовить вход.");
        if (active) setOptions(body);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось подготовить вход.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit() {
    if (!options || busy) return;
    setBusy(true);
    setError("");
    try {
      const credential = options.mode === "authenticate" ? await startAuthentication({ optionsJSON: options.options }) : await startRegistration({ optionsJSON: options.options });
      const endpoint = options.mode === "authenticate" ? "/api/auth/passkey/login/verify" : "/api/auth/passkey/login/register";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ response: credential, ...(options.mode === "register" ? { label: label.trim() || "Это устройство" } : {}) }),
      });
      if (!response.ok) throw new Error("Passkey не принят. Попробуйте ещё раз или используйте восстановление.");
      router.push("/");
    } catch (reason: unknown) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "Passkey не принят. Попробуйте ещё раз.");
    }
  }

  const registering = options?.mode === "register";
  return (
    <section className="mt-6 grid gap-4" aria-labelledby="passkey-title">
      <div>
        <h2 id="passkey-title" className="text-lg font-black text-grape-800">Подтвердите вход passkey</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">Используйте Face ID, Touch ID или PIN этого устройства. Шестизначный код для обычного входа не нужен.</p>
      </div>
      {registering ? (
        <label className="grid gap-1.5 text-sm font-bold text-grape-800">
          Название устройства
          <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} autoComplete="off" className="h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-normal text-ink focus:border-grape-600 focus:outline-none" />
        </label>
      ) : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">{error}</p> : null}
      <button type="button" onClick={submit} disabled={!options || busy} className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">
        {busy ? "Проверяем…" : registering ? "Настроить passkey и войти" : "Войти с passkey"}
      </button>
      <a href="/login/mfa" className="text-center text-sm font-bold text-grape-700 underline">Восстановление через резервный фактор</a>
    </section>
  );
}
