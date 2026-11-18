import type { Metadata } from "next";
import { BirthdaysPage } from "@/components/birthdays/BirthdaysPage";

const title = "Дни рождения детей в Алматы";
const description =
  "День рождения ребёнка в Boom Bala, Алматы: пакеты HAPPY PARTY, STAR PARTY и BOOM BALA PARTY, состав, цены и скидка 30% в будние дни.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/birthdays",
    languages: { "ru-KZ": "/birthdays", "kk-KZ": "/kk/birthdays" },
  },
  openGraph: {
    title: "Дни рождения детей в Алматы — Boom Bala",
    description: "Праздничные пакеты Boom Bala для дня рождения ребёнка: состав, цены и скидка 30% в будние дни.",
    url: "/birthdays",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Дни рождения детей в Алматы — Boom Bala",
    description: "Праздничные пакеты Boom Bala для дня рождения ребёнка: состав, цены и скидка 30% в будние дни.",
    images: ["/opengraph-image"],
  },
};

export default function BirthdaysRu() {
  return <BirthdaysPage locale="ru" />;
}
