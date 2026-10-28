import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PasskeyLogin } from "@/components/passkeys/PasskeyLogin";
import { getPendingSession } from "@/server/dal";

export const metadata: Metadata = { title: "Подтверждение входа" };

export default async function PasskeyLoginPage() {
  if (!(await getPendingSession())) redirect("/login");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-[2rem] border border-line bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">Boom Bala</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-grape-800">Безопасный вход</h1>
        <PasskeyLogin />
      </div>
    </main>
  );
}
