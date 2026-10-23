import type { Metadata } from "next";
import { privacyPolicy, type PolicyText } from "@/content/privacy";
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

/** Operator requisites come from the environment, not from the repository. Missing values are simply left out. */
function operator(lang: "ru" | "kk"): string {
  const name = process.env.LEGAL_OPERATOR_NAME?.trim();
  const iin = process.env.LEGAL_OPERATOR_IIN?.trim();
  const address = process.env.LEGAL_OPERATOR_REG_ADDRESS?.trim();
  if (lang === "ru") {
    return `Оператор: ИП «АМАНОВ»${name ? `, ${name}` : ""}${iin ? ` (ИИН ${iin})` : ""}.${address ? ` Адрес регистрации ИП: ${address}.` : ""}`;
  }
  return `Оператор: «АМАНОВ» ЖК${name ? `, ${name}` : ""}${iin ? ` (ЖСН ${iin})` : ""}.${address ? ` ЖК тіркеу мекенжайы: ${address}.` : ""}`;
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
  return (
    <section aria-label="Политика обработки персональных данных" className="py-12 md:py-20">
      <Container>
        <div className="max-w-3xl">
          <nav aria-label="Язык / Тіл" className="mb-6 flex gap-4 text-sm font-semibold text-grape-700">
            <a href="#ru" className="underline decoration-sun-400 decoration-2 underline-offset-2">Русский</a>
            <a href="#kk" className="underline decoration-sun-400 decoration-2 underline-offset-2">Қазақша</a>
          </nav>
          <Policy id="ru" lang="ru" text={privacyPolicy.ru} />
          <Policy id="kk" lang="kk" text={privacyPolicy.kk} />
        </div>
      </Container>
    </section>
  );
}
