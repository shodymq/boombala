import type { Metadata } from "next";
import { Container } from "@/components/ui/Container";
import { ConsentForm } from "@/components/consent/ConsentForm";
import { fetchPublishedDocuments, type PlatformDocument } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Регистрация посетителя",
  robots: { index: false, follow: false },
  alternates: { canonical: "/consent" },
};
export const dynamic = "force-dynamic";

async function loadDocuments(): Promise<PlatformDocument[] | null> {
  if (process.env.CONSENT_FORM_ENABLED !== "1") return null;
  try {
    const docs = await fetchPublishedDocuments();
    // Registration needs both the rules and the data-processing consent to be published; otherwise nothing is collected.
    return docs.some((d) => d.kind === "visit_rules") && docs.some((d) => d.kind === "personal_data_consent") ? docs : null;
  } catch {
    return null;
  }
}

export default async function ConsentPage() {
  const docs = await loadDocuments();
  const shown = docs?.filter((d) => ["visit_rules", "companion_duties", "personal_data_consent"].includes(d.kind));
  return (
    <section aria-labelledby="consent-title" className="py-10 md:py-16">
      <Container>
        <div className="mx-auto max-w-xl">
          <h1 id="consent-title" className="font-display text-[1.85rem] font-black leading-[1.1] tracking-tight text-grape-800 sm:text-4xl">
            Регистрация посетителя
          </h1>
          {shown ? (
            <>
              <p className="mt-3 text-base text-grape-900">Это регистрация и согласие. Она не означает посещение и не бронирует время.</p>
              <ConsentForm documents={shown.map((d) => ({ kind: d.kind, version: d.version, title: d.title, body: d.body }))} />
            </>
          ) : (
            <p role="status" className="mt-4 text-lg leading-relaxed text-grape-900">
              Онлайн-регистрация временно недоступна. Пожалуйста, обратитесь к администратору на входе.
            </p>
          )}
        </div>
      </Container>
    </section>
  );
}
