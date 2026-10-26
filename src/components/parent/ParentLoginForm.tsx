"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Two steps: phone, then the 6-digit SMS code. Talks only to our own BFF (same origin, JSON).
 * The phone number is held in component state only: never in the URL, never in storage, never logged.
 */

const MESSAGES: Record<string, string> = {
  invalid_phone: "Введите казахстанский мобильный номер, например +7 707 123 45 67.",
  invalid_code: "Неверный код. Проверьте SMS и попробуйте снова.",
  login_expired: "Код устарел. Запросите новый.",
  rate_limited: "Слишком много попыток. Попробуйте позже.",
  unavailable: "Сервис временно недоступен. Попробуйте позже.",
};

const GENERIC = "Не удалось выполнить действие. Попробуйте ещё раз.";

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

export function ParentLoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const fail = (data: Record<string, unknown>) => {
    const key = typeof data.error === "string" ? data.error : "";
    setError(MESSAGES[key] ?? GENERIC);
  };

  async function requestCode() {
    setBusy(true);
    setError(null);
    const r = await post("/api/parent/otp/request", { phone });
    setBusy(false);
    if (!r.ok) return fail(r.data);
    setStep("code");
    setCode("");
    setCooldown(typeof r.data.resendAfterSeconds === "number" ? r.data.resendAfterSeconds : 60);
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    const r = await post("/api/parent/otp/verify", { code });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error === "login_expired") setStep("phone");
      return fail(r.data);
    }
    router.replace("/account");
    router.refresh();
  }

  return (
    <section className="mx-auto max-w-md px-4 py-12">
      <h1 className="font-display text-3xl font-extrabold text-grape-900">Вход в личный кабинет</h1>
      <p className="mt-2 text-grape-700">Войдите по номеру телефона. Тот же аккаунт, что в приложении Boom Bala.</p>

      {step === "phone" ? (
        <form
          className="mt-8 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void requestCode();
          }}
        >
          <label className="block">
            <span className="text-sm font-bold text-grape-800">Номер телефона</span>
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 707 123 45 67"
              className="mt-1 block w-full rounded-2xl border border-grape-200 px-4 py-3 text-base"
            />
          </label>
          <button type="submit" disabled={busy} className="w-full rounded-full bg-sun-400 px-5 py-3 font-display font-extrabold text-grape-900 disabled:opacity-60">
            Получить код
          </button>
        </form>
      ) : (
        <form
          className="mt-8 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void verifyCode();
          }}
        >
          <label className="block">
            <span className="text-sm font-bold text-grape-800">Код из SMS</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="mt-1 block w-full rounded-2xl border border-grape-200 px-4 py-3 text-center text-2xl tracking-[0.4em]"
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 6} className="w-full rounded-full bg-sun-400 px-5 py-3 font-display font-extrabold text-grape-900 disabled:opacity-60">
            Войти
          </button>
          <button
            type="button"
            disabled={busy || cooldown > 0}
            onClick={() => void requestCode()}
            className="w-full text-sm font-bold text-grape-700 underline disabled:no-underline disabled:opacity-60"
          >
            {cooldown > 0 ? `Отправить код повторно через ${cooldown} с` : "Отправить код повторно"}
          </button>
        </form>
      )}

      {error ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
