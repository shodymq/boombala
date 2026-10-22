import type { Metadata } from "next";
import { Container } from "@/components/ui/Container";
import { ConsentForm } from "@/components/consent/ConsentForm";
import { ConsentDraftPreview } from "@/components/consent/ConsentDraftPreview";
import { fetchPublishedDocuments, type PlatformDocument } from "@/lib/platform";

export const metadata: Metadata = {
  title: "QR-регистрация сопровождающего",
  description: "Ознакомление с правилами посещения и регистрация взрослого сопровождающего в Boom Bala.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/consent" },
};
export const dynamic = "force-dynamic";

async function loadDocuments(): Promise<PlatformDocument[] | null> {
  if (process.env.CONSENT_FORM_ENABLED !== "1") return null;
  try {
    const docs = await fetchPublishedDocuments();
    // A registration may be accepted only when BOTH documents have been published.
    return docs.some((d) => d.kind === "visit_rules") && docs.some((d) => d.kind === "personal_data_consent") ? docs : null;
  } catch {
    return null;
  }
}

export default async function ConsentPage() {
  const docs = await loadDocuments();
  const shown = docs?.filter((d) => ["visit_rules", "companion_duties", "personal_data_consent"].includes(d.kind));
  return (
    <section aria-labelledby="consent-title" className="pb-16 pt-6 sm:pt-10 md:pb-24">
      <Container>
        <div className="mx-auto max-w-2xl">
          <div className="relative overflow-hidden rounded-[2rem] bg-grape-800 px-6 py-8 text-white sm:px-9 sm:py-10">
            <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full border-[28px] border-grape-600 opacity-70" />
            <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 -right-10 h-44 w-44 rounded-full bg-grape-700" />
            <div className="relative">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-sun-300">Boom Bala · для взрослых сопровождающих</p>
              <h1 id="consent-title" className="mt-4 max-w-[18ch] font-display text-[2rem] font-black leading-[1.08] tracking-tight sm:text-[2.75rem]">
                Ознакомление с правилами и согласие
              </h1>
              <p className="mt-4 max-w-[47ch] text-sm leading-relaxed text-grape-100 sm:text-base">
                Перед посещением центра ознакомьтесь с документами и подтвердите согласие от своего имени.
                Это не бронирование и не отметка о посещении.
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 rounded-2xl border border-grape-100 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted">Оператор персональных данных</p>
              <p className="mt-1 font-display text-base font-black text-grape-800">ИП Аманов</p>
            </div>
            <p className="text-xs leading-relaxed text-muted sm:max-w-[15rem] sm:text-right">
              Подтверждение оформляет взрослый сопровождающий, а не ребёнок.
            </p>
          </div>

          <ol aria-label="Этапы регистрации" className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
            {[
              ["01", "Ваши данные"],
              ["02", "Документы"],
              ["03", "Согласие"],
            ].map(([number, label]) => (
              <li key={number} className="rounded-2xl bg-grape-50 px-3 py-3 text-center sm:px-5">
                <span className="block text-xs font-black text-grape-600">{number}</span>
                <span className="mt-1 block font-display text-xs font-extrabold leading-tight text-grape-800 sm:text-sm">{label}</span>
              </li>
            ))}
          </ol>

          {shown ? (
            <div className="mt-5 rounded-3xl border border-grape-100 bg-white px-5 pb-7 pt-1 shadow-soft sm:px-8">
              <ConsentForm
                documents={shown.map((d) => ({ kind: d.kind, version: d.version, title: d.title, body: d.body }))}
              />
            </div>
          ) : (
            <ConsentDraftPreview />
          )}

          <p className="mt-8 text-center text-xs leading-relaxed text-muted">
            Страница предназначена для регистрации взрослого сопровождающего. Сведения о ребёнке здесь не запрашиваются.
          </p>
        </div>
      </Container>
    </section>
  );
}
