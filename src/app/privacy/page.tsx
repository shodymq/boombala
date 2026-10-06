import type { Metadata } from "next";
import { siteConfig } from "@/services/config";
import { Container } from "@/components/ui/Container";

export const metadata: Metadata = {
  title: "Политика конфиденциальности",
  description: "Какие данные собирает форма заявки Boom Bala, зачем и как с ними связаться.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Политика конфиденциальности — Boom Bala",
    description: "Как Boom Bala обрабатывает данные, отправленные через форму заявки на сайте.",
    url: "/privacy",
    locale: "ru_RU",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Политика конфиденциальности — Boom Bala",
    description: "Как Boom Bala обрабатывает данные, отправленные через форму заявки на сайте.",
    images: ["/opengraph-image"],
  },
};

const h2 = "mt-10 font-display text-2xl font-black tracking-tight text-grape-800 md:text-3xl";
const p = "mt-3 text-base leading-relaxed text-grape-900 md:text-lg";
const li = "relative pl-5 before:absolute before:left-0 before:top-[0.7em] before:h-2 before:w-2 before:rounded-full before:bg-sun-400";

export default function PrivacyPage() {
  const { city, street, mall, floor } = siteConfig.location;
  return (
    <section aria-labelledby="privacy-title" className="py-12 md:py-20">
      <Container>
        <div className="max-w-3xl">
        <h1
          id="privacy-title"
          className="font-display text-[1.85rem] font-black leading-[1.1] tracking-tight text-grape-800 [overflow-wrap:anywhere] sm:text-5xl"
        >
          Политика конфиденциальности
        </h1>
        <p className={p}>
          Здесь описано, какие данные мы получаем через форму заявки на сайте Boom Bala и как мы их используем.
        </p>

        <h2 className={h2}>Кто получает данные</h2>
        <p className={p}>
          Детский развлекательный центр Boom Bala, {city}, {street}, {mall}, {floor}. Реквизиты оператора данных
          (наименование юридического лица, БИН) будут опубликованы здесь после подтверждения.
        </p>

        <h2 className={h2}>Какие данные мы получаем</h2>
        <p className={p}>Из формы заявки:</p>
        <ul className="mt-3 grid gap-2 text-base text-grape-900 md:text-lg">
          <li className={li}>имя;</li>
          <li className={li}>номер телефона;</li>
          <li className={li}>желаемая дата праздника;</li>
          <li className={li}>количество детей (если вы его указали);</li>
          <li className={li}>выбранный пакет;</li>
          <li className={li}>ваше согласие на обработку данных.</li>
        </ul>
        <p className={p}>
          Вместе с заявкой автоматически передаются: страница сайта, с которой отправлена форма, источник перехода,
          рекламные UTM-метки (если они были в ссылке) и время отправки.
        </p>

        <h2 className={h2}>Зачем нам эти данные</h2>
        <p className={p}>
          Мы используем их, чтобы связаться с вами по заявке на день рождения: уточнить дату, пакет и детали
          праздника.
        </p>

        <h2 className={h2}>Кому они передаются</h2>
        <p className={p}>
          Заявка отправляется сотрудникам Boom Bala в рабочий чат Telegram. Данные формы (имя, телефон) не передаются
          в сервисы аналитики.
        </p>

        <h2 className={h2}>Аналитика и cookies</h2>
        <p className={p}>
          Сайт может использовать Google Analytics и Meta Pixel для статистики посещений и оценки рекламы. Эти сервисы
          могут использовать cookies и получают обезличенные сведения о действиях на сайте: например, что открыта
          форма или просмотрены цены.
        </p>

        <h2 className={h2}>Ваши права</h2>
        <p className={p}>
          Вы можете запросить уточнение или удаление своих данных, написав нам в Instagram{" "}
          <a
            href={siteConfig.contacts.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2"
          >
            {siteConfig.contacts.instagramHandle}
          </a>
          .
        </p>
        </div>
      </Container>
    </section>
  );
}
