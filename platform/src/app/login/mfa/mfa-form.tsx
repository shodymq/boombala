"use client";

import Link from "next/link";
import { useActionState } from "react";
import { redeemEnrollmentAction, submitSecondFactor, type MfaState } from "./actions.ts";

const field = "h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-normal text-ink focus:border-grape-600 focus:outline-none";

export function MfaForm({ enrolled, signedIn, needsCode, secret, otpauth }: { enrolled: boolean; signedIn: boolean; needsCode?: boolean; secret?: string; otpauth?: string }) {
  const [state, action, pending] = useActionState<MfaState | undefined, FormData>(needsCode ? redeemEnrollmentAction : submitSecondFactor, undefined);

  if (state?.recoveryCodes) {
    return (
      <div className="mt-6 grid gap-4">
        <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">Второй фактор включён.</p>
        <div>
          <h2 className="text-base font-black text-grape-800">Коды восстановления</h2>
          <p className="mt-1 text-sm text-muted">Каждый код работает один раз. Запишите их и храните отдельно от телефона. Больше они показаны не будут.</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-base" data-testid="recovery-codes">
            {state.recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
        <Link href="/" className="inline-flex h-12 items-center justify-center rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600">Я сохранил коды, продолжить</Link>
      </div>
    );
  }

  if (signedIn) {
    return (
      <div className="mt-6 grid gap-4">
        <p className="text-sm text-muted">Вы уже вошли.</p>
        <Link href="/" className="inline-flex h-12 items-center justify-center rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600">Продолжить</Link>
      </div>
    );
  }

  if (needsCode) {
    return (
      <form action={action} className="mt-6 grid gap-4" data-testid="enroll-code-form">
        <div className="grid gap-2 text-sm">
          <p className="font-bold text-grape-800">Нужен код настройки</p>
          <p className="text-muted">Для первого входа владелец выдаёт одноразовый код. Пароля недостаточно. Попросите код у владельца лично и введите его здесь.</p>
        </div>
        <label className="grid gap-1.5 text-sm font-bold text-grape-800">
          Код настройки
          <input name="code" inputMode="text" autoComplete="off" autoCapitalize="characters" required maxLength={24} placeholder="XXXX-XXXX-XXXX" className={field} />
        </label>
        {state?.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">{state.error}</p> : null}
        <button type="submit" disabled={pending} className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">{pending ? "Проверяем…" : "Продолжить"}</button>
      </form>
    );
  }

  return (
    <form action={action} className="mt-6 grid gap-4">
      {enrolled ? (
        <p className="text-sm text-muted">Введите 6-значный код из приложения-аутентификатора или код восстановления.</p>
      ) : (
        <div className="grid gap-2 text-sm">
          <p className="font-bold text-grape-800">Включите второй фактор</p>
          <p className="text-muted">1. Откройте приложение-аутентификатор на телефоне. 2. Добавьте ключ вручную или откройте ссылку ниже на телефоне. 3. Введите код из приложения.</p>
          <p>Ключ: <code className="break-all font-mono font-bold" data-testid="mfa-secret">{secret}</code></p>
          <a href={otpauth} className="font-bold text-grape-700 underline">Открыть в приложении-аутентификаторе</a>
        </div>
      )}
      <label className="grid gap-1.5 text-sm font-bold text-grape-800">
        Код
        <input name="code" inputMode="text" autoComplete="one-time-code" required maxLength={40} className={field} />
      </label>
      {state?.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600 disabled:opacity-60">{pending ? "Проверяем…" : enrolled ? "Войти" : "Включить и войти"}</button>
    </form>
  );
}
