import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Cabinet } from "@/components/parent/Cabinet";
import { currentSession, loadCabinet, parentState } from "@/lib/parent/server";
import { FastapiError } from "@/lib/fastapi/core.ts";
import { ParentSessionEnded, type ParentCabinet } from "@/lib/parent/core";

export const metadata: Metadata = { title: "Личный кабинет", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Personal cabinet. Data comes from FastAPI through the server-side BFF; nothing is cached in the browser. */
export default async function AccountPage() {
  if (!parentState().enabled) notFound();
  const current = await currentSession();
  if (!current) redirect("/account/login");

  let cabinet: ParentCabinet | null = null;
  try {
    cabinet = await loadCabinet(current.sid);
  } catch (error) {
    if (error instanceof ParentSessionEnded) redirect("/account/login");
    if (!(error instanceof FastapiError)) throw error;
  }

  if (!cabinet) {
    return (
      <section className="mx-auto max-w-md px-4 py-12">
        <h1 className="font-display text-2xl font-extrabold text-grape-900">Личный кабинет временно недоступен</h1>
        <p className="mt-2 text-grape-700">Не удалось загрузить данные. Обновите страницу позже.</p>
      </section>
    );
  }
  return <Cabinet data={cabinet} csrfToken={current.session.csrfToken} />;
}
