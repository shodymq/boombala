import type { Attraction, AttractionPhoto } from "@/types";

/**
 * Attractions. Limits come from the official signs at each attraction (checked against the photos).
 * Only `published: true` entries appear on the site. Photos must be real Boom Bala photos; faces of
 * children are cropped out. Nothing is guessed: unknown limits go to `toClarify`.
 */

const photo = (file: string, alt: string, height: number, width = 2000): AttractionPhoto => ({
  src: `/attractions/${file}`,
  alt,
  width,
  height,
});

export const attractions: Attraction[] = [
  {
    id: "skyline",
    slug: "skyline",
    name: "SKYLINE",
    subtitle: "Воздушная горка",
    shortDescription: "Светящаяся многополосная горка.",
    images: [photo("skyline-1.webp", "Светящаяся многополосная горка SKYLINE и лестница с оранжево-чёрными ступенями", 1109)],
    limits: { height: { min: 120, max: 187 }, weight: { min: 35, max: 90 } },
    rules: [],
    published: true,
    featured: true,
  },
  {
    id: "alatau",
    slug: "alatau",
    name: "ALATAU",
    shortDescription: "Большая оранжево-белая горка.",
    images: [
      photo("alatau-1.webp", "Большая оранжево-белая горка ALATAU", 1197),
      photo("alatau-2.webp", "Горка ALATAU, вид сбоку", 1125),
    ],
    limits: { age: { min: 8, max: 16 } },
    rules: [],
    published: true,
    featured: true,
  },
  {
    id: "raduga",
    slug: "raduga",
    name: "RADUGA",
    shortDescription: "Игровая зона с шариками, горками и экраном.",
    images: [
      photo("raduga-1.webp", "Игровая зона RADUGA: бассейн с шариками, горки и экран", 1125),
      photo("raduga-2.webp", "Игровая зона RADUGA, другой ракурс", 1125),
    ],
    limits: { age: { min: 5, max: 14 }, height: { min: 100, max: 170 }, weight: { min: 15, max: 65 } },
    rules: [],
    published: true,
    featured: true,
  },
  {
    id: "amazonia",
    slug: "amazonia",
    name: "AMAZONIA",
    subtitle: "Радужная сеть",
    shortDescription: "Многоуровневая конструкция с сетчатым переходом и закрытыми горками.",
    images: [
      photo("amazonia-1.webp", "Многоуровневая оранжевая конструкция AMAZONIA с сетчатыми уровнями", 1991, 1600),
      photo("amazonia-2.webp", "AMAZONIA: сетчатый переход и закрытые горки", 1991, 1600),
    ],
    // The sign states no age, height or weight limits: nothing is invented.
    limits: { admissionNote: "Условия допуска уточняйте у оператора" },
    rules: [],
    rulesDraft: {
      source: "Табличка у аттракциона (IMG_6119), русский текст; казахский текст совпадает по смыслу. Ждёт проверки администрацией.",
      items: [
        "Посетители обязаны неукоснительно следовать указаниям персонала.",
        "Дети должны постоянно находиться под присмотром взрослых сопровождающих.",
        "Не пытайтесь выполнять действия, превышающие ваши физические возможности.",
        "ЗАПРЕЩЕНЫ грубая игра, толчки и другие опасные действия.",
        "К посещению аттракциона не допускаются лица: с травмами спины, шеи, коленей, суставов; с заболеваниями сердца или дыхательной системы; с переломами; беременные женщины; с любыми другими физическими или ментальными ограничениями.",
        "ЗАПРЕЩЕНО проносить еду, напитки и острые предметы.",
      ],
      footer:
        "При нарушении правил инструктор немедленно останавливает посетителя и напоминает о правилах. В случае повторного нарушения посетитель удаляется с аттракциона, о чем сообщается дежурному администратору.",
    },
    published: true,
    featured: true,
  },
  {
    id: "football-zone",
    slug: "football-zone",
    name: "FOOTBALL ZONE",
    shortDescription: "Футбольная площадка.",
    images: [
      photo("football-1.webp", "Футбольная площадка FOOTBALL ZONE", 1125),
      photo("football-2.webp", "FOOTBALL ZONE, вид с другой стороны", 1125),
    ],
    limits: { other: ["Только без обуви"] },
    rules: [],
    published: true,
  },

  // ---- Prepared, not public yet --------------------------------------------------------------
  {
    id: "mini-tube",
    slug: "mini-tube",
    name: "MINI TUBE",
    subtitle: "Тюбинг",
    images: [],
    limits: { height: { max: 160 }, weight: { max: 53 }, toClarify: ["Минимальный рост"] },
    rules: [],
    published: false,
    needsConfirmation: [
      "Нет фото самого аттракциона.",
      "Минимальный рост: русский текст таблички — «до 160 см», казахский — «108–160 см». Уточнить у администрации.",
    ],
  },
  {
    id: "sky-jump",
    slug: "sky-jump",
    name: "SKY JUMP",
    subtitle: "Горка «Ракета»",
    images: [],
    limits: { age: { min: 8, max: 16 }, toClarify: ["Рост"] },
    rules: [],
    published: false,
    needsConfirmation: [
      "Нет подтверждённого фото (кандидаты IMG_6068, IMG_6072 — ждём ответа).",
      "Минимальный рост: русский текст — 120 см, казахский — 108 см. Уточнить у администрации.",
    ],
  },
  {
    id: "jump-zone",
    slug: "jump-zone",
    name: "JUMP ZONE",
    subtitle: "Батутный парк",
    images: [],
    limits: { age: { min: 5 }, weight: { max: 90 } },
    rules: [],
    published: false,
    needsConfirmation: ["Фото батутов (IMG_6086/6087) не привязано: JUMP ZONE или JUMPY — ждём ответа. Лица детей кадрировать."],
  },
  {
    id: "jumpy",
    slug: "jumpy",
    name: "JUMPY",
    images: [],
    limits: { age: { min: 8, max: 16 } },
    rules: [],
    published: false,
    needsConfirmation: [
      "Фото не привязано (см. JUMP ZONE).",
      "На табличке только казахский текст: нужен русский текст от администрации.",
    ],
  },
];
