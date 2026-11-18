import type { Metadata } from "next";
import { requireUser } from "@/server/dal";
import { PasswordFields } from "./password-fields";

export const metadata: Metadata = { title: "Мой пароль" };

// Fixed texts only: the code comes from the URL and must never be echoed back.
const ERRORS: Record<string, string> = {
  mismatch: "Новые пароли не совпадают.",
  current: "Неверный текущий пароль.",
  weak: "Новый пароль должен быть не короче 12 символов.",
};

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  await requireUser();
  const { notice, error } = await searchParams;
  return (
    <div className="crm-page crm-account-page">
      <header>
        <p className="crm-eyebrow">Безопасность</p>
        <h1 className="crm-page-title">Мой пароль</h1>
        <p className="crm-page-subtitle">Новый пароль должен содержать не менее 12 символов.</p>
      </header>
      {notice ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">Пароль изменён. На других устройствах вы будете разлогинены.</p> : null}
      {error ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          {ERRORS[error] ?? "Не удалось сменить пароль."}
        </p>
      ) : null}
      <PasswordFields />
    </div>
  );
}
