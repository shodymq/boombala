import type { Metadata } from "next";
import { BrandArt } from "@/components/brand-art";
import { redirect } from "next/navigation";
import { getPendingSession, getSession } from "@/server/dal";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  if (await getPendingSession()) redirect("/login/mfa");
  return (
    <main className="crm-login-shell">
      <section className="crm-login-aside">
        <p className="text-xs font-extrabold uppercase tracking-[0.16em]">Boom Bala · CRM</p>
        <h1>Рабочее пространство команды</h1>
        <p>Заявки, расписание и работа филиала — в одной панели.</p>
        <BrandArt className="crm-login-art" size={128} />
      </section>
      <section className="crm-login-card">
        <p className="crm-eyebrow">Вход для сотрудников</p>
        <h2 className="text-2xl font-extrabold tracking-tight text-grape-800">Добро пожаловать</h2>
        <LoginForm />
      </section>
    </main>
  );
}
