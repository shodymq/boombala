"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

interface PasskeyItem {
  id: string;
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeyManager({ initial }: { initial: PasskeyItem[] }) {
  const [items, setItems] = useState(initial);
  const [options, setOptions] = useState<PublicKeyCredentialCreationOptionsJSON | null>(null);
  const [label, setLabel] = useState("Это устройство");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/passkey/options", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as PublicKeyCredentialCreationOptionsJSON | { error?: string } | null;
        if (!response.ok || !body || "error" in body) throw new Error("Не удалось подготовить регистрацию passkey.");
        if (active) setOptions(body as PublicKeyCredentialCreationOptionsJSON);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось подготовить регистрацию passkey.");
      });
    return () => {
      active = false;
    };
  }, [items.length]);

  async function register() {
    if (!options || busy) return;
    setBusy(true);
    setError("");
    try {
      const credential = await startRegistration({ optionsJSON: options });
      const response = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ response: credential, label: label.trim() || "Это устройство" }),
      });
      if (!response.ok) throw new Error("Passkey не зарегистрирован.");
      window.location.reload();
    } catch (reason: unknown) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "Passkey не зарегистрирован.");
    }
  }

  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/passkey/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error("Passkey не отозван.");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Passkey не отозван.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4 rounded-3xl border border-line bg-white p-5" aria-labelledby="passkeys-title">
      <div>
        <h2 id="passkeys-title" className="text-lg font-black text-grape-800">Passkeys</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">Добавьте отдельный passkey на каждый личный телефон или компьютер. Для замены сначала зарегистрируйте новый, затем отзовите старый.</p>
      </div>
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
              <div>
                <p className="font-bold text-grape-900">{item.label}</p>
                <p className="text-xs text-muted">{item.deviceType === "multiDevice" ? "синхронизируемый" : "на устройстве"}{item.backedUp ? " · резервирован провайдером" : ""}</p>
              </div>
              <button type="button" onClick={() => revoke(item.id)} disabled={busy} className="h-10 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-60">Отозвать</button>
            </li>
          ))}
        </ul>
      ) : <p className="rounded-2xl bg-paper p-3 text-sm text-muted">Passkey ещё не зарегистрирован.</p>}
      <label className="grid gap-1.5 text-sm font-bold text-grape-800">
        Название нового устройства
        <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} autoComplete="off" className="h-11 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-normal text-ink focus:border-grape-600 focus:outline-none" />
      </label>
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">{error}</p> : null}
      <button type="button" onClick={register} disabled={!options || busy} className="h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">Добавить passkey</button>
    </section>
  );
}
