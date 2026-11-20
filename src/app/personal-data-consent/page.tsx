import type { Metadata } from "next";
import { LegalDocumentLayout, LegalDocumentUnavailable } from "@/features/legal/components/LegalDocumentLayout";
import { getPublishedLegalDocument } from "@/features/legal/lib/legal-documents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Согласие на обработку персональных данных",
  description: "Полное опубликованное согласие Boom Bala на обработку персональных данных при QR-регистрации.",
  alternates: { canonical: "/personal-data-consent" },
  openGraph: {
    title: "Согласие на обработку персональных данных — Boom Bala",
    description: "Полная опубликованная редакция согласия Boom Bala.",
    url: "/personal-data-consent",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
};

export default async function PersonalDataConsentPage() {
  const document = await getPublishedLegalDocument("personal_data_consent");
  return document ? (
    <LegalDocumentLayout document={document} kind="personal-data-consent" />
  ) : (
    <LegalDocumentUnavailable title="Согласие временно недоступно" description="Не удалось получить опубликованную редакцию согласия из CRM." />
  );
}
