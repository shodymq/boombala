"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions.ts";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState | undefined, FormData>(login, undefined);
  return (
    <form action={action} className="mt-6 grid gap-4">
      <label className="grid gap-1.5 text-sm font-bold text-grape-800">
        E-mail
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          className="h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-normal text-ink focus:border-grape-600 focus:outline-none"
        />
      </label>
      <label className="grid gap-1.5 text-sm font-bold text-grape-800">
        Пароль
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          className="h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-normal text-ink focus:border-grape-600 focus:outline-none"
        />
      </label>
      {state?.error ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-semibold text-grape-900">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white transition-colors hover:bg-grape-600 disabled:opacity-60"
      >
        {pending ? "Входим…" : "Войти"}
      </button>
    </form>
  );
}
