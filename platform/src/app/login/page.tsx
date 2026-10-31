import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getPendingSession, getSession } from "@/server/dal";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Вход" };

const FIGMA_SOURCE = "https://www.figma.com/design/nFN83oaOWjVyMMCgV4shBY/1-600-Free-Illustrations---Vector-illustrations-set--svg-png---Community?node-id=1-65";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  if (await getPendingSession()) redirect("/login/mfa");
  return (
    <main className="crm-login-shell">
      <section className="crm-login-aside">
        <p className="text-xs font-extrabold uppercase tracking-[0.16em]">Boom Bala · CRM</p>
        <h1>Рабочее пространство команды</h1>
        <p>Заявки, расписание и работа филиала — в одной панели.</p>
        <Image className="crm-login-art" src="/illustrations/milano-hello.svg" alt="" width={154} height={154} priority />
        <a className="crm-login-credit" href={FIGMA_SOURCE} target="_blank" rel="noreferrer">Illustration by Streamline</a>
      </section>
      <section className="crm-login-card">
        <p className="crm-eyebrow">Вход для сотрудников</p>
        <h2 className="text-2xl font-extrabold tracking-tight text-grape-800">Добро пожаловать</h2>
        <LoginForm />
      </section>
    </main>
  );
}
