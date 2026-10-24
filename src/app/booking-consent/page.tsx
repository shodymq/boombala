import type { Metadata } from "next";
import { bookingConsent, type BookingConsentText } from "@/content/booking-consent";
import { Container } from "@/components/ui/Container";

export const metadata: Metadata = {
  title: "Согласие на обработку данных при бронировании",
  description: "Полный текст согласия на обработку данных для формы заявки на день рождения Boom Bala (RU/KK).",
  alternates: { canonical: "/booking-consent" },
};
export const dynamic = "force-dynamic";

const h3 = "mt-8 font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl";
const p = "mt-3 text-base leading-relaxed text-grape-900 md:text-lg";

/** The operator's name and IIN come from the environment, never from the repository. Missing values are left out. */
function operator(lang: "ru" | "kk", withIin: boolean): string {
  const name = process.env.LEGAL_OPERATOR_NAME?.trim() ?? "";
  const iin = process.env.LEGAL_OPERATOR_IIN?.trim() ?? "";
  const validIin = /^\d{12}$/.test(iin) ? iin : "";
  if (lang === "ru") return `ИП «АМАНОВ»${name ? `, ${name}` : ""}${withIin && validIin ? `, ИИН ${validIin}` : ""}`;
  return `«АМАНОВ» ЖК${name ? `, ${name}` : ""}${withIin && validIin ? `; ЖСН ${validIin}` : ""}`;
}

function Doc({ id, lang, text }: { id: string; lang: "ru" | "kk"; text: BookingConsentText }) {
  const fill = (t: string) => t.replace("@@OPI@@", operator(lang, true)).replace("@@OP@@", operator(lang, false));
  return (
    <article id={id} lang={lang} aria-labelledby={`${id}-title`} className="mt-10 border-t border-grape-100 pt-8 first:mt-0 first:border-0 first:pt-0">
      <h2 id={`${id}-title`} className="font-display text-[1.6rem] font-black leading-tight tracking-tight text-grape-800 [overflow-wrap:anywhere] sm:text-4xl">
        {text.title}
      </h2>
      <p className="mt-2 text-sm text-muted">{text.subtitle}</p>
      {text.sections.map((sec) => (
        <section key={sec.h}>
          <h3 className={h3}>{sec.h}</h3>
          {sec.p.map((t, i) => (
            <p key={i} className={p}>{fill(t)}</p>
          ))}
        </section>
      ))}
    </article>
  );
}

export default function BookingConsentPage() {
  return (
    <section aria-label="Согласие на обработку данных при бронировании" className="py-12 md:py-20">
      <Container>
        <div className="max-w-3xl">
          <nav aria-label="Язык / Тіл" className="mb-6 flex gap-4 text-sm font-semibold text-grape-700">
            <a href="#ru" className="underline decoration-sun-400 decoration-2 underline-offset-2">Русский</a>
            <a href="#kk" className="underline decoration-sun-400 decoration-2 underline-offset-2">Қазақша</a>
          </nav>
          <Doc id="ru" lang="ru" text={bookingConsent.ru} />
          <Doc id="kk" lang="kk" text={bookingConsent.kk} />
        </div>
      </Container>
    </section>
  );
}
