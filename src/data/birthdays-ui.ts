import type { Locale } from "@/types";

/**
 * Interface copy of the birthday pages (RU and KZ). Every visible string of the birthday section comes from here, so the Kazakh page
 * never falls back to Russian text. Package names and their programme texts come from the approved Pricing V3 (`birthday-packages-v3.json`).
 * The Kazakh strings are a translation of the approved Russian copy and should be checked by a native speaker before publication.
 */
export interface BirthdaysUi {
  eyebrow: string;
  heroTitle: [string, string];
  heroLead: string;
  heroCta: string;
  heroCompare: string;
  packagesEyebrow: string;
  packagesTitle: string;
  packagesLead: string;
  tabsLabel: string;
  keyPointsLabel: (name: string) => string;
  regularPrice: string;
  weekdayCaption: string;
  weekdayShort: string;
  savingsLabel: string;
  discountBadge: string;
  showFull: string;
  hideFull: string;
  choiceNote: string;
  statKids: string;
  statProgramme: string;
  statAnimators: string;
  statAnimatorsChoice: string;
  chooseN: (n: number) => string;
  welcomeRow: string;
  shows: string;
  badgeOptimal: string;
  badgeFlagship: string;
  sharedTitle: string;
  sharedItems: string[];
  compareLink: string;
  compareEyebrow: string;
  compareTitle: string;
  compareCaption: string;
  compareLegend: string;
  compareSharedTitle: string;
  rowKids: string;
  rowDurationLabel: string;
  packageHeader: string;
  rowGuests: string;
  rowAnimators: string;
  rowAdults: string;
  rowRoom: string;
  rowShow: string;
  rowWorkshop: string;
  rowChallenge: string;
  rowFigures: string;
  rowPinata: string;
  rowInvitation: string;
  rowPhoto: string;
  rowPriceRegular: string;
  rowPriceWeekday: string;
  rowSavings: string;
  rowDiscountExtra: string;
  animatorsSelectable: (n: number) => string;
  animatorsFixed: (n: number) => string;
  adultsValue: (n: number) => string;
  roomValue: (hours: number) => string;
  workshopValue: (kind: "standard" | "premium") => string;
  figuresNotStated: string;
  included: string;
  notIncluded: string;
  flagshipNoteCake: string;
  roomsEyebrow: string;
  roomsTitle: string;
  roomsLead: string;
  roomsNote: string;
  roomViewLabel: string;
  roomClose: string;
  roomPrev: string;
  roomNext: string;
  roomPhotosLabel: (name: string) => string;
  roomPhotoOf: (i: number, total: number) => string;
  roomVideo: string;
  roomVideoLabel: (name: string) => string;
  roomVideoError: string;
  roomVideoRetry: string;
  roomBook: string;
  roomNotGuaranteed: string;
  howEyebrow: string;
  howTitle: string;
  howSteps: { title: string; text: string }[];
  howNote: string;
  faqEyebrow: string;
  faqTitle: string;
  faq: { title: string; text: string }[];
  whatsappTitle: string;
  whatsappBody: string;
  whatsappCall: string;
  whatsappButton: string;
  menuTitle: string;
  menuBody: string;
  menuCta: string;
  langSwitchLabel: string;
  langSwitchHref: string;
  langSwitchText: string;
  legendTableLabel: string;
  dash: string;
  hourShort: string;
  includedTitle: string;
  homeTitle: [string, string];
  homeLead: string;
  homeCompareLead: string;
  bonusTitle: string;
  bonusText: string;
  photoTitle: string;
  photoText: string;
  minShort: string;
}

export const BIRTHDAYS_UI: Record<Locale, BirthdaysUi> = {
  ru: {
    eyebrow: "Дни рождения",
    heroTitle: ["Праздник", "в Boom Bala"],
    heroLead: "Три пакета на выбор. В будние дни действует скидка 30%.",
    heroCta: "Узнать о свободной дате",
    heroCompare: "Сравнить пакеты",
    packagesEyebrow: "Пакеты",
    packagesTitle: "Выберите пакет",
    packagesLead: "Цена, что входит и чем пакеты отличаются. Подробности раскрываются по нажатию.",
    tabsLabel: "Праздничные пакеты",
    keyPointsLabel: (name) => `Главное в ${name}`,
    regularPrice: "Обычная цена",
    weekdayCaption: "Цена в будние дни",
    weekdayShort: "в будние дни",
    savingsLabel: "Экономия в будни",
    discountBadge: "−30% в будни",
    showFull: "Показать полный состав",
    hideFull: "Скрыть состав",
    choiceNote: "1 на выбор",
    statKids: "детей",
    statProgramme: "программа",
    statAnimators: "аниматора",
    statAnimatorsChoice: "аниматора на выбор",
    chooseN: (n) => (n === 1 ? "1 на выбор" : `${n} на выбор`),
    welcomeRow: "Welcome-встреча",
    shows: "Шоу",
    badgeOptimal: "Оптимальный выбор",
    badgeFlagship: "Флагманский пакет",
    sharedTitle: "Во всех пакетах",
    sharedItems: [
      "Одна из 4 тематических банкетных комнат на 4 часа — по выбору, при наличии даты",
      "Скидка 20% на входные билеты дополнительных детей",
      "Скидка 30% на все пакеты в будние дни",
    ],
    compareLink: "Сравнить все пакеты",
    compareEyebrow: "Сравнение",
    compareTitle: "Три пакета — в одной таблице",
    compareCaption: "Сравнение праздничных пакетов Boom Bala",
    compareLegend: "Прочерк — не входит в стоимость. Торт в стоимость пакетов не входит. Цены в тенге.",
    compareSharedTitle: "Общие условия",
    rowKids: "Дети (включая именинника)",
    rowGuests: "Гостей сверх именинника",
    rowDurationLabel: "Программа",
    packageHeader: "Пакет",
    rowAnimators: "Аниматоры",
    rowAdults: "Взрослых включено",
    rowRoom: "Банкетная комната",
    rowShow: "Шоу или интерактив на выбор",
    rowWorkshop: "Мастер-класс на выбор",
    rowChallenge: "Челлендж на выбор",
    rowFigures: "Фигурки из шариков каждому",
    rowPinata: "Пиньята с угощениями",
    rowInvitation: "Персональное онлайн-приглашение",
    rowPhoto: "Фото с именинником",
    rowPriceRegular: "Выходные, ₸",
    rowPriceWeekday: "Будни, ₸",
    rowSavings: "Экономия в будни, ₸",
    rowDiscountExtra: "Скидка на доп. детей",
    animatorsSelectable: (n) => (n === 1 ? "1 на выбор" : `${n} на выбор`),
    animatorsFixed: (n) => String(n),
    adultsValue: (n) => (n === 0 ? "—" : String(n)),
    roomValue: (h) => `${h} часа`,
    workshopValue: () => "1 на выбор",
    figuresNotStated: "Не заявлено",
    included: "Входит",
    notIncluded: "Не входит",
    flagshipNoteCake: "Торт в стоимость ни одного пакета не входит. Торжественный вынос торта — часть программы; по торту уточняйте у менеджера.",
    roomsEyebrow: "Комнаты",
    roomsTitle: "Выберите комнату для праздника",
    roomsLead: "Четыре тематические комнаты — выберите атмосферу, которая понравится имениннику.",
    roomsNote: "Изображения интерьеров созданы на основе фотографий. Отдельные детали могут отличаться.",
    roomViewLabel: "Посмотреть комнату",
    roomClose: "Закрыть",
    roomPrev: "Предыдущее фото",
    roomNext: "Следующее фото",
    roomPhotosLabel: () => "Фотографии комнаты",
    roomPhotoOf: (i, t) => `Фото ${i} из ${t}`,
    roomVideo: "Смотреть видео комнаты",
    roomVideoLabel: (name) => `Видео комнаты: ${name}`,
    roomVideoError: "Не удалось загрузить видео. Проверьте соединение и попробуйте ещё раз. Оставить заявку можно и без видео.",
    roomVideoRetry: "Попробовать снова",
    roomBook: "Узнать о бронировании",
    roomNotGuaranteed: "Выбор комнаты не гарантирует, что она свободна на вашу дату.",
    howEyebrow: "Как забронировать",
    howTitle: "Три шага до праздника",
    howSteps: [
      { title: "Выберите пакет", text: "Сравните состав и цену в будний или выходной день." },
      { title: "Назовите дату и комнату", text: "Укажите желаемый день, комнату и число детей." },
      { title: "Отправьте заявку", text: "Менеджер проверит свободную дату и подтвердит бронь." },
    ],
    howNote: "Заявка — не подтверждённое бронирование. Дату и время подтверждает менеджер.",
    faqEyebrow: "Важно знать",
    faqTitle: "Условия пакетов",
    faq: [
      {
        title: "Программа и аренда комнаты — не одно и то же",
        text: "Программа длится 1 час в HAPPY, 1,5 часа в STAR и 2,5 часа в BOOM BALA PARTY. Банкетная комната снимается на 4 часа. Программа не означает непрерывную анимацию весь период.",
      },
      {
        title: "Взрослые",
        text: "Вход трёх взрослых сопровождающих включён в BOOM BALA PARTY. Остальные пакеты рассчитаны на детей и именинника; дополнительных взрослых менеджер рассчитает отдельно.",
      },
      {
        title: "Шоу, мастер-класс и челлендж",
        text: "В STAR выбираются два WOW-шоу и один челлендж. В BOOM BALA PARTY выбираются два шоу из шести, один мастер-класс из шести и один челлендж. Все варианты показаны в карточке пакета. Перечень шоу для HAPPY уточняет менеджер.",
      },
      {
        title: "Торт",
        text: "Торт в стоимость ни одного пакета не входит. Торжественный вынос торта — часть программы в STAR и BOOM BALA PARTY.",
      },
      {
        title: "Цены и даты",
        text: "В будние дни цена на 30% ниже обычной. Для праздничных дат и дополнительных гостей уточняйте условия у менеджера.",
      },
    ],
    whatsappTitle: "Удобнее написать?",
    whatsappBody: "Сообщение подготовим за вас, останется нажать «Отправить» в WhatsApp.",
    whatsappCall: "Или позвоните:",
    whatsappButton: "Написать в WhatsApp",
    menuTitle: "Меню кафе Boom Bala",
    menuBody: "Пицца, фастфуд и суши, напитки и банкетные блюда.",
    menuCta: "Смотреть меню",
    langSwitchLabel: "Язык версии",
    langSwitchHref: "/kk/birthdays",
    langSwitchText: "Қазақша",
    legendTableLabel: "Легенда таблицы",
    dash: "—",
    hourShort: "ч",
    includedTitle: "Что входит",
    homeTitle: ["Три способа", "устроить BOOM"],
    homeLead: "Три праздничных пакета. В будние дни действует скидка 30%.",
    homeCompareLead: "Все три пакета в одной таблице.",
    bonusTitle: "Эксклюзивный бонус: персональное онлайн-приглашение",
    bonusText: "Имя именинника, дата, время и тематика комнаты.",
    photoTitle: "Фото с именинником",
    photoText: "Фото включено в пакет. Количество и формат фотографий не обещаем.",
    minShort: "мин",
  },
  kk: {
    eyebrow: "Туған күн",
    heroTitle: ["Мереке", "Boom Bala-да"],
    heroLead: "Таңдау үшін үш пакет. Жұмыс күндері — 30% жеңілдік.",
    heroCta: "Бос күнді білу",
    heroCompare: "Пакеттерді салыстыру",
    packagesEyebrow: "Пакеттер",
    packagesTitle: "Пакетті таңдаңыз",
    packagesLead: "Баға, құрамы және пакеттердің айырмашылығы. Толығырақ — басқанда ашылады.",
    tabsLabel: "Мерекелік пакеттер",
    keyPointsLabel: (name) => `${name} пакетінің негізгісі`,
    regularPrice: "Қалыпты баға",
    weekdayCaption: "Жұмыс күндеріндегі баға",
    weekdayShort: "жұмыс күндері",
    savingsLabel: "Жұмыс күндері үнемдеу",
    discountBadge: "Жұмыс күндері −30%",
    showFull: "Толық құрамды көрсету",
    hideFull: "Құрамды жасыру",
    choiceNote: "1 таңдау бойынша",
    statKids: "бала",
    statProgramme: "бағдарлама",
    statAnimators: "аниматор",
    statAnimatorsChoice: "аниматор таңдау бойынша",
    chooseN: (n) => (n === 1 ? "1 таңдау бойынша" : `${n} таңдау бойынша`),
    welcomeRow: "Welcome-кездесу",
    shows: "Шоу",
    badgeOptimal: "Оңтайлы таңдау",
    badgeFlagship: "Флагмандық пакет",
    sharedTitle: "Барлық пакеттерде",
    sharedItems: [
      "4 тақырыптық банкет бөлмесінің бірі — 4 сағатқа, таңдау бойынша, күн бос болған жағдайда",
      "Қосымша балалардың кіру билетіне 20% жеңілдік",
      "Барлық пакетке жұмыс күндері 30% жеңілдік",
    ],
    compareLink: "Барлық пакеттерді салыстыру",
    compareEyebrow: "Салыстыру",
    compareTitle: "Үш пакет — бір кестеде",
    compareCaption: "Boom Bala мерекелік пакеттерін салыстыру",
    compareLegend: "Сызықша — құнына кірмейді. Торт ешбір пакеттің құнына кірмейді. Бағалар теңгемен.",
    compareSharedTitle: "Ортақ шарттар",
    rowKids: "Балалар (туған күн иесін қоса)",
    rowGuests: "Туған күн иесінен басқа қонақтар",
    rowDurationLabel: "Бағдарлама",
    packageHeader: "Пакет",
    rowAnimators: "Аниматорлар",
    rowAdults: "Ересектер кіреді",
    rowRoom: "Банкет бөлмесі",
    rowShow: "Шоу немесе интерактив таңдау бойынша",
    rowWorkshop: "Шеберлік сабағы таңдау бойынша",
    rowChallenge: "Челлендж таңдау бойынша",
    rowFigures: "Әр балаға шардан мүсіншелер",
    rowPinata: "Тәттісі бар пиньята",
    rowInvitation: "Жеке онлайн-шақырту",
    rowPhoto: "Туған күн иесімен фото",
    rowPriceRegular: "Демалыс күндері, ₸",
    rowPriceWeekday: "Жұмыс күндері, ₸",
    rowSavings: "Жұмыс күндері үнемдеу, ₸",
    rowDiscountExtra: "Қосымша балаға жеңілдік",
    animatorsSelectable: (n) => (n === 1 ? "1 таңдау бойынша" : `${n} таңдау бойынша`),
    animatorsFixed: (n) => String(n),
    adultsValue: (n) => (n === 0 ? "—" : String(n)),
    roomValue: (h) => `${h} сағат`,
    workshopValue: () => "1 таңдау бойынша",
    figuresNotStated: "Көрсетілмеген",
    included: "Кіреді",
    notIncluded: "Кірмейді",
    flagshipNoteCake: "Торт ешбір пакеттің құнына кірмейді. Салтанатты торт әкелу — бағдарламаның бөлігі; торт туралы менеджерден нақтылаңыз.",
    roomsEyebrow: "Бөлмелер",
    roomsTitle: "Мереке үшін бөлмені таңдаңыз",
    roomsLead: "Төрт тақырыптық бөлме — туған күн иесіне ұнайтын атмосфераны таңдаңыз.",
    roomsNote: "Интерьер суреттері фотосуреттер негізінде жасалған. Кейбір бөлшектер ерекшеленуі мүмкін.",
    roomViewLabel: "Бөлмеге қарау",
    roomClose: "Жабу",
    roomPrev: "Алдыңғы фото",
    roomNext: "Келесі фото",
    roomPhotosLabel: () => "Бөлме фотосуреттері",
    roomPhotoOf: (i, t) => `${i} / ${t} фото`,
    roomVideo: "Бөлме бейнесін көру",
    roomVideoLabel: (name) => `Бөлме бейнесі: ${name}`,
    roomVideoError: "Бейнені жүктеу мүмкін болмады. Байланысты тексеріп, қайта көріңіз. Бейнесіз де өтінім қалдыруға болады.",
    roomVideoRetry: "Қайта көру",
    roomBook: "Брондау туралы білу",
    roomNotGuaranteed: "Бөлмені таңдау сол күні бос болатынына кепілдік бермейді.",
    howEyebrow: "Қалай брондау керек",
    howTitle: "Мерекеге дейін үш қадам",
    howSteps: [
      { title: "Пакетті таңдаңыз", text: "Жұмыс немесе демалыс күніне құрамы мен бағасын салыстырыңыз." },
      { title: "Күнді және бөлмені атаңыз", text: "Қалаған күнді, бөлмені және балалар санын көрсетіңіз." },
      { title: "Өтінім жіберіңіз", text: "Менеджер бос күнді тексеріп, брондауды растайды." },
    ],
    howNote: "Өтінім — әлі расталмаған брондау. Күн мен уақытты менеджер растайды.",
    faqEyebrow: "Маңызды",
    faqTitle: "Пакет шарттары",
    faq: [
      {
        title: "Бағдарлама мен бөлмені жалдау — бірдей емес",
        text: "Бағдарлама HAPPY-де 1 сағат, STAR-да 1,5 сағат, BOOM BALA PARTY-де 2,5 сағат. Банкет бөлмесі 4 сағатқа жалданады. Бағдарлама бүкіл кезең бойы үздіксіз анимацияны білдірмейді.",
      },
      {
        title: "Ересектер",
        text: "Үш сопровождающий ересектің кіруі BOOM BALA PARTY-ге кіреді. Басқа пакеттер балаларға және туған күн иесіне арналған; қосымша ересектерді менеджер бөлек есептейді.",
      },
      {
        title: "Шоу, шеберлік сабағы және челлендж",
        text: "STAR-да екі WOW-шоу және бір челлендж таңдалады. BOOM BALA PARTY-де алты шоудан екеуі, алты шеберлік сабағынан бірі және бір челлендж таңдалады. Барлық нұсқа пакет карточкасында көрсетілген. HAPPY үшін шоу тізімін менеджер нақтылайды.",
      },
      {
        title: "Торт",
        text: "Торт ешбір пакеттің құнына кірмейді. Салтанатты торт әкелу — STAR мен BOOM BALA PARTY бағдарламасының бөлігі.",
      },
      {
        title: "Бағалар және күндер",
        text: "Жұмыс күндері баға қалыптыдан 30% төмен. Мерекелік күндер мен қосымша қонақтар үшін шарттарды менеджерден нақтылаңыз.",
      },
    ],
    whatsappTitle: "Жазу ыңғайлы ма?",
    whatsappBody: "Хабарламаны сіз үшін дайындаймыз, WhatsApp-та «Жіберу» түймесін басу ғана қалады.",
    whatsappCall: "Немесе қоңырау шалыңыз:",
    whatsappButton: "WhatsApp-қа жазу",
    menuTitle: "Boom Bala кафесінің мәзірі",
    menuBody: "Пицца, фастфуд және суши, сусындар мен банкет тағамдары.",
    menuCta: "Мәзірді көру",
    langSwitchLabel: "Нұсқа тілі",
    langSwitchHref: "/birthdays",
    langSwitchText: "Русский",
    legendTableLabel: "Кесте белгілері",
    dash: "—",
    hourShort: "сағ",
    includedTitle: "Не кіреді",
    homeTitle: ["Үш тәсіл", "BOOM ұйымдастыру"],
    homeLead: "Үш мерекелік пакет. Жұмыс күндері — 30% жеңілдік.",
    homeCompareLead: "Үш пакет бір кестеде.",
    bonusTitle: "Эксклюзивті бонус: жеке онлайн-шақырту",
    bonusText: "Туған күн иесінің аты, күні, уақыты және бөлме тақырыбы.",
    photoTitle: "Туған күн иесімен фото",
    photoText: "Фото пакетке кіреді. Фотосурет саны мен форматын уәде етпейміз.",
    minShort: "мин",
  },
};
