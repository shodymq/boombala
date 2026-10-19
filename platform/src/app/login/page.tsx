import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/dal";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-[2rem] border border-line bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">Boom Bala</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-grape-800">Вход для сотрудников</h1>
        <LoginForm />
      </div>
    </main>
  );
}
