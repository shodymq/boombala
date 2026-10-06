import type { BirthdayPackage } from "@/types";

const greetingOptions = ["Ханское", "Волшебное", "Королевское"];
const animationOptions = ["Подростковый челлендж", "Малышник", "Стандартная"];
const questOptions = [
  "Бравл Старс",
  "Цифровой цирк",
  "Роблокс",
  "Игра в кальмара",
  "Национальный",
  "Супергерой",
  "Вилли Вонка",
  "Гарри Поттер",
];
const showOptions = [
  "Серебряное шоу",
  "Неоновое шоу",
  "Шоу летающих корзинок",
  "Дино-шоу",
  "Что в коробке?",
  "Поролоновое шоу",
];

/**
 * Source: official Boom Bala birthday posters (WOW / MAGIC / BOOM PARTY).
 * Weekday price is the regular price with the printed −30% applied.
 */
export const birthdayPackages: BirthdayPackage[] = [
  {
    id: "wow-party",
    name: "WOW PARTY",
    shortName: "WOW",
    tagline: "Праздник в Boom Bala",
    price: 37900,
    weekdayPrice: 26530,
    weekdayDiscountPercent: 30,
    freeChildren: 5,
    extraGuestDiscountPercent: 20,
    program: [
      {
        key: "greeting",
        title: "Торжественное поздравление",
        note: "15 минут",
        options: greetingOptions,
      },
      {
        key: "animation",
        title: "Анимационная программа на выбор",
        count: 1,
        options: animationOptions,
      },
      {
        key: "workshop",
        title: "Мастер-класс",
        count: 1,
        options: ["ШДМ шар", "Тематическая кабинка на ваш выбор"],
      },
    ],
  },
  {
    id: "magic-party",
    name: "MAGIC PARTY",
    shortName: "MAGIC",
    tagline: "Волшебный праздник в Boom Bala",
    price: 44900,
    weekdayPrice: 31430,
    weekdayDiscountPercent: 30,
    freeChildren: 6,
    extraGuestDiscountPercent: 20,
    program: [
      { key: "greeting", title: "Торжественное поздравление", options: greetingOptions },
      { key: "animation", title: "Анимационная программа", count: 1, options: animationOptions },
      { key: "quest", title: "Квест на выбор", count: 1, options: questOptions },
      { key: "shows", title: "Шоу на выбор", count: 1, options: showOptions },
      {
        key: "workshop",
        title: "Мастер-класс",
        count: 1,
        options: ["ШДМ шар", "Тематическая кабинка"],
      },
    ],
  },
  {
    id: "boom-party",
    name: "BOOM PARTY",
    shortName: "BOOM",
    tagline: "Яркие эмоции для ваших детей!",
    price: 79990,
    // NEEDS CONFIRMATION: the poster prints 55 930 ₸ with "−30%", but 79 990 × 0.7 = 55 993.
    // Kept exactly as printed until the venue confirms the real weekday price.
    weekdayPrice: 55930,
    weekdayPriceNeedsConfirmation: true,
    weekdayDiscountPercent: 30,
    freeChildren: 6,
    extraGuestDiscountPercent: 20,
    highlight: "Самый полный пакет",
    program: [
      { key: "animators", title: "2 аниматора", count: 2 },
      {
        key: "characters",
        title: "Встреча гостей ростовыми куклами",
        options: ["Лаги Ваги", "Кисси Мисси", "Принцесса", "Зайка", "Тедди", "Стич"],
      },
      { key: "greeting", title: "Торжественное поздравление", options: greetingOptions },
      { key: "animation", title: "Анимационная программа на выбор", count: 1, options: animationOptions },
      { key: "quest", title: "Квест на выбор", count: 1, options: questOptions },
      { key: "shows", title: "2 шоу на выбор", count: 2, options: showOptions },
      {
        key: "workshop",
        title: "Мастер-класс на выбор",
        count: 1,
        options: [
          "Брелок",
          "Слайм",
          "Радуга в бутылке",
          "Рисование",
          "ШДМ шарики",
          "Гипсовые фигурки",
          "Антистресс",
        ],
      },
      {
        key: "challenge",
        title: "Челлендж",
        options: ["Трясуны", "Шародувы", "Угадай напиток"],
      },
      { key: "pinata", title: "Праздничная пиньята" },
    ],
  },
];
