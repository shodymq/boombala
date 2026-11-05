import type { Metadata } from "next";
import { LegalDocumentLayout, LegalDocumentUnavailable } from "@/features/legal/components/LegalDocumentLayout";
import { getPublishedLegalDocument } from "@/features/legal/lib/legal-documents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Правила посещения Boom Bala",
  description: "Полные опубликованные Правила посещения Boom Bala на русском и казахском языках.",
  alternates: { canonical: "/rules" },
  openGraph: {
    title: "Правила посещения Boom Bala",
    description: "Полная опубликованная редакция Правил посещения Boom Bala.",
    url: "/rules",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
};

export default async function RulesPage() {
  const document = await getPublishedLegalDocument("visit_rules");
  return document ? (
    <LegalDocumentLayout document={document} kind="rules" pdfHref="/legal/boom-bala-rules-v1.3-ru-kk.pdf" />
  ) : (
    <LegalDocumentUnavailable title="Правила временно недоступны" description="Не удалось получить опубликованную редакцию Правил из CRM." />
  );
}
