import type { Metadata } from "next";
import { requireUser } from "@/server/dal";
import { changeOwnPasswordAction } from "./actions";

export const metadata: Metadata = { title: "Мой пароль" };

// Fixed texts only: the code comes from the URL and must never be echoed back.
const ERRORS: Record<string, string> = {
  mismatch: "Новые пароли не совпадают.",
  current: "Неверный текущий пароль.",
  weak: "Новый пароль должен быть не короче 12 символов.",
};

const input = "h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  await requireUser();
  const { notice, error } = await searchParams;
  return (
    <div className="grid max-w-md gap-4">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Мой пароль</h1>
      {notice ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">Пароль изменён. На других устройствах вы будете разлогинены.</p> : null}
      {error ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          {ERRORS[error] ?? "Не удалось сменить пароль."}
        </p>
      ) : null}
      <form action={changeOwnPasswordAction} className="grid gap-3 rounded-3xl border border-line bg-white p-5">
        <input name="current" type="password" placeholder="Текущий пароль" required autoComplete="current-password" maxLength={128} className={input} aria-label="Текущий пароль" />
        <input name="next" type="password" placeholder="Новый пароль (минимум 12 символов)" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label="Новый пароль" />
        <input name="repeat" type="password" placeholder="Повторите новый пароль" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label="Повторите новый пароль" />
        <button type="submit" className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600">Сменить пароль</button>
      </form>
    </div>
  );
}
