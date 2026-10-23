import type { Metadata } from "next";
import { privacyPolicy, privacyPolicyKz, type PolicyText } from "@/content/privacy";
import { Container } from "@/components/ui/Container";

export const metadata: Metadata = {
  title: "Политика обработки персональных данных",
  description: "Политика обработки персональных данных Boom Bala (RU/KK): какие данные собираются, зачем, кому передаются и как отозвать согласие.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Политика обработки персональных данных — Boom Bala",
    description: "Как Boom Bala обрабатывает персональные данные.",
    url: "/privacy",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Политика обработки персональных данных — Boom Bala",
    description: "Как Boom Bala обрабатывает персональные данные.",
    images: ["/opengraph-image"],
  },
};

const h2 = "mt-8 font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl";
const p = "mt-3 text-base leading-relaxed text-grape-900 md:text-lg";

export const dynamic = "force-dynamic";

/** Public operator details are read from private runtime variables; never silently publish a partial identity. */
function legalOperator() {
  const name = process.env.LEGAL_OPERATOR_NAME?.trim() ?? "";
  const iin = process.env.LEGAL_OPERATOR_IIN?.trim() ?? "";
  const address = process.env.LEGAL_OPERATOR_REG_ADDRESS?.trim() ?? "";
  if (name.length < 5 || !/^\d{12}$/.test(iin) || address.length < 10) return null;
  return { name, iin, address };
}
function operator(lang: "ru" | "kk"): string {
  const data = legalOperator();
  if (!data) return lang === "ru"
    ? "Оператор: ИП «АМАНОВ». Полные регистрационные реквизиты временно недоступны на сайте; их необходимо разместить до запуска электронной регистрации."
    : "Оператор: «АМАНОВ» ЖК. Толық тіркеу деректемелері сайтта уақытша қолжетімсіз; олар электрондық тіркеуді іске қосуға дейін жариялануы тиіс.";
  return lang === "ru"
    ? `Оператор: ИП «АМАНОВ», ${data.name} (ИИН ${data.iin}). Адрес регистрации ИП: ${data.address}.`
    : `Оператор: «АМАНОВ» ЖК, ${data.name} (ЖСН ${data.iin}). ЖК тіркеу мекенжайы: ${data.address}.`;
}

function Policy({ id, lang, text }: { id: string; lang: "ru" | "kk"; text: PolicyText }) {
  return (
    <article id={id} lang={lang} aria-labelledby={`${id}-title`} className="mt-10 border-t border-grape-100 pt-8 first:mt-0 first:border-0 first:pt-0">
      <h2 id={`${id}-title`} className="font-display text-[1.6rem] font-black leading-tight tracking-tight text-grape-800 [overflow-wrap:anywhere] sm:text-4xl">
        {text.title}
      </h2>
      <p className="mt-2 text-sm text-muted">{text.subtitle}</p>
      {text.sections.map((sec) => (
        <section key={sec.h}>
          <h3 className={h2}>{sec.h}</h3>
          {sec.p.map((t, i) => (
            <p key={i} className={p}>
              {t.replace("@@OPERATOR@@", operator(lang))}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}

export default function PrivacyPage() {
  // The Kazakhstan deployment publishes the text for its own scheme (storage and processing in Kazakhstan, Telegram without personal data).
  const policy = process.env.SITE_PROFILE === "kz-production" ? privacyPolicyKz : privacyPolicy;
  return (
    <section aria-label="Политика обработки персональных данных" className="py-12 md:py-20">
      <Container>
        <div className="max-w-3xl">
          {!legalOperator() && (
            <p role="alert" className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-grape-900">
              Полные реквизиты ИП ещё не настроены. Новая редакция политики не готова к использованию при сборе данных.
              <span lang="kk" className="mt-1 block">ЖК толық деректемелері әлі орнатылмаған. Деректерді жинау үшін бұл редакция дайын емес.</span>
            </p>
          )}
          <nav aria-label="Язык / Тіл" className="mb-6 flex gap-4 text-sm font-semibold text-grape-700">
            <a href="#ru" className="underline decoration-sun-400 decoration-2 underline-offset-2">Русский</a>
            <a href="#kk" className="underline decoration-sun-400 decoration-2 underline-offset-2">Қазақша</a>
          </nav>
          <Policy id="ru" lang="ru" text={policy.ru} />
          <Policy id="kk" lang="kk" text={policy.kk} />
        </div>
      </Container>
    </section>
  );
}
