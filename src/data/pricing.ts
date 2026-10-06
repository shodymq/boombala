import type { PricingTable } from "@/types";

/** Source: official Boom Bala price list. */
export const pricingTable: PricingTable = {
  categories: [
    {
      id: "weekday",
      title: "Будние дни",
      rows: [
        { id: "infant", label: "До 1 года", price: 0 },
        { id: "toddler", label: "До 3 лет", price: 3000 },
        { id: "child", label: "С 3 до 15 лет", price: 4000 },
      ],
    },
    {
      id: "weekend",
      title: "Выходные и праздничные дни",
      rows: [
        { id: "infant", label: "До 1 года", price: 0 },
        { id: "toddler", label: "До 3 лет", price: 4000 },
        { id: "child", label: "С 3 до 15 лет", price: 5000 },
      ],
    },
  ],
  perks: [
    { id: "birthday", label: "Именинники", value: "бесплатно" },
    { id: "disability", label: "Дети с ограниченными возможностями", value: "бесплатно" },
    { id: "large-family", label: "Многодетным семьям", value: "скидка 30%" },
  ],
  companionPrice: 500,
};
