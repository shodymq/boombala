import type { Locale } from "@/types";
import type { LeadFields } from "@/lib/lead";

/**
 * Lead form copy (RU and KZ). The form is shared by every page; the locale comes from the page that opened it.
 * Validation messages from `validateLead` are Russian; the KZ form shows the Kazakh text for the same field instead
 * (see `leadErrorText`), so a Kazakh visitor never reads a Russian message.
 */
export interface LeadUi {
  title: string;
  thanks: string;
  close: string;
  managerNote: string;
  sent: string;
  or: string;
  whatsappHint: string;
  writeWhatsApp: string;
  nameLabel: string;
  phoneLabel: string;
  phoneHint: string;
  phonePlaceholder: string;
  dateLabel: string;
  pickDate: string;
  childrenLabel: string;
  optional: string;
  childrenPlaceholder: string;
  packageLabel: string;
  undecided: string;
  roomLabel: string;
  noRoom: string;
  roomHint: string;
  consentBefore: string;
  consentLink: string;
  consentAfter: string;
  submit: string;
  submitting: string;
  errorRate: string;
  errorWhatsApp: string;
  errorInstagram: string;
  phoneDigitsError: string;
  dateLocale: string;
}

export const LEAD_UI: Record<Locale, LeadUi> = {
  ru: {
    title: "Забронировать праздник",
    thanks: "Спасибо!",
    close: "Закрыть",
    managerNote: "Менеджер свяжется с вами.",
    sent: "Заявка отправлена. Менеджер свяжется с вами.",
    or: "или",
    whatsappHint: "Откроется WhatsApp с готовым сообщением",
    writeWhatsApp: "Написать в WhatsApp",
    nameLabel: "Ваше имя",
    phoneLabel: "Телефон",
    phoneHint: " (после +7 — 10 цифр)",
    phonePlaceholder: "707 123 45 67",
    dateLabel: "Желаемая дата",
    pickDate: "Выберите дату",
    childrenLabel: "Количество детей",
    optional: "(по желанию)",
    childrenPlaceholder: "Например, 8",
    packageLabel: "Пакет праздника",
    undecided: "Ещё не определились",
    roomLabel: "Предпочитаемая комната",
    noRoom: "Не выбрана",
    roomHint: "Это пожелание: выбор не гарантирует, что комната свободна на вашу дату.",
    consentBefore: "Я согласен(на) на",
    consentLink: "обработку персональных данных",
    consentAfter: "для связи по заявке.",
    submit: "Отправить заявку",
    submitting: "Отправляем…",
    errorRate: "Слишком много попыток. Попробуйте чуть позже.",
    errorWhatsApp: "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в WhatsApp.",
    errorInstagram: "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в Instagram.",
    phoneDigitsError: "Введите 10 цифр после +7",
    dateLocale: "ru-RU",
  },
  kk: {
    title: "Мерекені брондау",
    thanks: "Рақмет!",
    close: "Жабу",
    managerNote: "Менеджер сізбен байланысады.",
    sent: "Өтінім жіберілді. Менеджер сізбен байланысады.",
    or: "немесе",
    whatsappHint: "WhatsApp-та дайын хабарлама ашылады",
    writeWhatsApp: "WhatsApp-қа жазу",
    nameLabel: "Атыңыз",
    phoneLabel: "Телефон",
    phoneHint: " (+7 кейін — 10 сан)",
    phonePlaceholder: "707 123 45 67",
    dateLabel: "Қалаған күн",
    pickDate: "Күнді таңдаңыз",
    childrenLabel: "Балалар саны",
    optional: "(қаласаңыз)",
    childrenPlaceholder: "Мысалы, 8",
    packageLabel: "Мереке пакеті",
    undecided: "Әлі шешпедік",
    roomLabel: "Қалаған бөлме",
    noRoom: "Таңдалмаған",
    roomHint: "Бұл тілек: бөлмені таңдау сол күні бос болатынына кепілдік бермейді.",
    consentBefore: "Мен өтінім бойынша байланысу үшін",
    consentLink: "дербес деректерді өңдеуге",
    consentAfter: "келісемін.",
    submit: "Өтінімді жіберу",
    submitting: "Жіберілуде…",
    errorRate: "Тым көп әрекет. Біраз уақыттан кейін қайталаңыз.",
    errorWhatsApp: "Өтінімді жіберу мүмкін болмады. Қайта көріңіз немесе WhatsApp-та жазыңыз.",
    errorInstagram: "Өтінімді жіберу мүмкін болмады. Қайта көріңіз немесе Instagram-да жазыңыз.",
    phoneDigitsError: "+7 кейін 10 сан енгізіңіз",
    dateLocale: "kk-KZ",
  },
};

/** Kazakh text for each Russian validation message, keyed by field. The server's wording is kept for Russian only. */
const KK_FIELD_ERRORS: Partial<Record<keyof LeadFields, string>> = {
  name: "Атыңызды жазыңыз",
  phone: "Телефон нөмірін тексеріңіз",
  date: "Күнді дұрыс таңдаңыз",
  children: "1-ден 60-қа дейін",
  consent: "Келісімді растаңыз",
  room: "Бөлмені тізімнен таңдаңыз",
  slot: "Уақытты тізімнен таңдаңыз",
  package: "Пакетті таңдаңыз",
};

/** A retired package is named in Russian by the server; the Kazakh form shows the Kazakh sentence for it. */
const KK_RETIRED = "Бұл пакет енді сатылмайды. Өзекті пакеттердің бірін таңдаңыз.";

export function leadErrorText(field: keyof LeadFields, message: string, locale: Locale): string {
  if (locale === "ru") return message;
  if (field === "package" && message.includes("больше не продаётся")) return KK_RETIRED;
  return KK_FIELD_ERRORS[field] ?? message;
}
