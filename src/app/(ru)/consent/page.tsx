import type { Metadata } from "next";
import { Container } from "@/components/ui/Container";
import { ConsentForm } from "@/components/consent/ConsentForm";
import { ConsentDraftPreview } from "@/components/consent/ConsentDraftPreview";
import { fetchPublishedDocuments, type PlatformDocument } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Регистрация сопровождающего",
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
    <section aria-labelledby="consent-title" className="pb-14 pt-6 sm:pt-10">
      <Container>
        <div className="mx-auto max-w-xl">
          {shown ? (
            // The working form draws its own heading, language switch and note (RU / KK).
            <ConsentForm documents={shown.map((d) => ({ kind: d.kind, version: d.version, title: d.title, body: d.body }))} />
          ) : (
            <>
              <header>
                <h1 id="consent-title" className="font-display text-[1.75rem] font-black leading-tight tracking-tight text-grape-800 sm:text-3xl">
                  Регистрация сопровождающего
                </h1>
                <p className="mt-2 text-base leading-relaxed text-muted">Заполните форму перед посещением центра. Это займёт меньше минуты.</p>
              </header>
              <ConsentDraftPreview />
              <p className="mt-5 text-center text-xs leading-relaxed text-muted">Это не бронирование: регистрация не означает посещение. Бұл брондау емес: тіркелу келуді білдірмейді.</p>
            </>
          )}
        </div>
      </Container>
    </section>
  );
}
