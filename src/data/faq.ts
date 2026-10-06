import type { FaqItem } from "@/types";
import { pricingTable } from "./pricing";
import { membership } from "./membership";
import { formatTenge, formatPriceOrFree } from "@/lib/format";
import { siteConfig } from "@/services/config";
import { openingDateLabel } from "@/lib/opening";

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
    question: "Когда открывается Boom Bala?",
    answer: `Boom Bala открывается ${openingDateLabel()} 2026 года${siteConfig.opening.time ? ` в ${siteConfig.opening.time}` : ""}.`,
  },
  {
    id: "address",
    question: "Где находится Boom Bala?",
    answer: `${siteConfig.location.city}, ${siteConfig.location.street}, ${siteConfig.location.mall}, ${siteConfig.location.floor}.`,
  },
];
