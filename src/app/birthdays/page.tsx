import type { Metadata } from "next";
import { BirthdaysPage } from "@/components/birthdays/BirthdaysPage";

const title = "Дни рождения детей в Алматы — Boom Bala";
const description =
  "Пакеты HAPPY PARTY, STAR PARTY и BOOM BALA PARTY: состав, цены и скидка 30% в будние дни. Boom Bala, Алматы.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/birthdays",
    languages: { "ru-KZ": "/birthdays", "kk-KZ": "/kk/birthdays" },
  },
  openGraph: {
    title,
    description,
    url: "/birthdays",
    locale: "ru_KZ",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
};

export default function BirthdaysRu() {
  return <BirthdaysPage locale="ru" />;
}
