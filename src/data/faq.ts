import type { FaqItem } from "@/types";
import { pricingTable } from "./pricing";
import { membership } from "./membership";
import { formatTenge, formatPriceOrFree } from "@/lib/format";
import { siteConfig } from "@/services/config";
import { grandOpeningDayLabel, grandOpeningFullLabel, openingDateLabel, startFullLabel } from "@/lib/opening";

const [weekday, weekend] = pricingTable.categories;
const rowsText = (rows: typeof weekday.rows) =>
  rows.map((r) => `${r.label.toLowerCase()} — ${formatPriceOrFree(r.price)}`).join("; ");

/** Only questions with an answer confirmed by the official materials. */
export const faqItems: FaqItem[] = [
  {
    id: "entry",
    question: "Сколько стоит вход?",
    answer: `${weekday.title}: ${rowsText(weekday.rows)}. ${weekend.title}: ${rowsText(weekend.rows)}.`,
  },
  {
    id: "companion",
    question: "Сколько стоит вход сопровождающему?",
    answer: `Вход для сопровождающего — ${formatTenge(pricingTable.companionPrice)}.`,
  },
  {
    id: "large-family",
    question: "Есть ли скидка многодетным семьям?",
    answer: "Да, многодетным семьям — скидка 30%.",
  },
  {
    id: "birthday-free",
    question: "Бесплатно ли имениннику?",
    answer:
      "Да, вход для именинников бесплатный. В пакетах праздников также бесплатно проходят дети-гости: 5 в WOW PARTY и 6 в MAGIC PARTY и BOOM PARTY.",
  },
  {
    id: "membership",
    question: "Сколько стоит годовой абонемент?",
    answer: `${membership.name} — ${formatTenge(membership.price)}.`,
  },
  {
    id: "opening",
    question: "Когда открытие Boom Bala?",
    answer: {
      before: `Начинаем работу ${startFullLabel()}. Большое открытие — ${grandOpeningFullLabel()}.`,
      working: `Boom Bala уже работает с ${openingDateLabel()} 2026 года. Большое открытие — ${grandOpeningFullLabel()}.`,
      open: `Boom Bala открыт: работаем с ${openingDateLabel()} 2026 года, большое открытие прошло ${grandOpeningDayLabel()}.`,
    },
  },
  {
    id: "address",
    question: "Где находится Boom Bala?",
    answer: `${siteConfig.location.city}, ${siteConfig.location.street}, ${siteConfig.location.mall}, ${siteConfig.location.floor}.`,
  },
  {
    id: "kitchen",
    question: "Есть ли в Boom Bala кухня?",
    answer: "Да, в Boom Bala есть кухня. Меню и подробные условия опубликуем позже.",
  },
];
