import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { LegalLanguageSwitcher } from "@/features/legal/components/LegalLanguageSwitcher";
import { splitLegalLanguages } from "@/features/legal/lib/legal-documents";
import type { PlatformDocument } from "@/lib/platform";

export function LegalDocumentUnavailable({ title, description }: { title: string; description: string }) {
  return (
    <section aria-labelledby="legal-unavailable-title" className="py-12 md:py-20">
      <Container>
        <div className="max-w-3xl rounded-3xl border border-sun-300 bg-sun-100 p-6 text-grape-900 sm:p-8">
          <h1 id="legal-unavailable-title" className="font-display text-3xl font-black text-grape-800">{title}</h1>
          <p className="mt-3 text-base leading-relaxed">{description}</p>
          <p className="mt-5 text-sm leading-relaxed">Попробуйте обновить страницу позже или обратитесь к администратору на входе.</p>
        </div>
      </Container>
    </section>
  );
}

export function LegalDocumentLayout({ document, kind, pdfHref }: { document: PlatformDocument; kind: "rules" | "personal-data-consent"; pdfHref?: string }) {
  const languages = splitLegalLanguages(document.body);
  const isRules = kind === "rules";

  return (
    <section aria-labelledby="legal-document-title" className="py-10 md:py-16">
      <Container>
        <div className="mx-auto max-w-4xl">
          <header>
            <p className="text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">Boom Bala · юридические документы</p>
            <h1 id="legal-document-title" className="mt-3 font-display text-3xl font-black leading-tight text-grape-800 sm:text-5xl">{document.title}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted">
              <span className="rounded-full bg-grape-50 px-3 py-1 font-bold text-grape-700">Опубликованная редакция {document.version}</span>
              <span>Текст загружается из Production CRM</span>
            </div>
          </header>

          {isRules && pdfHref ? (
            <div className="mt-6 flex flex-wrap gap-3">
              <a href={pdfHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-grape-700 px-5 font-display text-sm font-extrabold text-white transition-colors hover:bg-grape-800">
                Открыть официальный PDF
              </a>
              <a href={pdfHref} download className="inline-flex min-h-11 items-center rounded-full border-2 border-grape-200 px-5 font-display text-sm font-extrabold text-grape-700 transition-colors hover:bg-grape-50">
                Скачать PDF
              </a>
            </div>
          ) : null}

          <LegalLanguageSwitcher ruMarkdown={languages.ru} kkMarkdown={languages.kk} />

          <nav aria-label="Юридические документы" className="mt-8 flex flex-wrap gap-x-5 gap-y-2 border-t border-grape-100 pt-5 text-sm font-semibold">
            {isRules ? <Link href="/personal-data-consent" className="text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2">Согласие на обработку ПДн</Link> : <Link href="/rules" className="text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2">Правила посещения</Link>}
            <Link href="/privacy" className="text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2">Политика конфиденциальности</Link>
          </nav>
        </div>
      </Container>
    </section>
  );
}
