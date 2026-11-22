import type { Metadata } from "next";
import { BirthdaysPage } from "@/components/birthdays/BirthdaysPage";

const title = "Баланың туған күні Алматыда — Boom Bala";
const description =
  "HAPPY PARTY, STAR PARTY және BOOM BALA PARTY пакеттері: құрамы, бағасы және жұмыс күндері 30% жеңілдік. Boom Bala, Алматы.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/kk/birthdays",
    languages: { "ru-KZ": "/birthdays", "kk-KZ": "/kk/birthdays" },
  },
  openGraph: {
    title,
    description,
    url: "/kk/birthdays",
    locale: "kk_KZ",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
};

export default function BirthdaysKk() {
  return <BirthdaysPage locale="kk" />;
}
