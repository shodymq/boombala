import { Plus } from "@phosphor-icons/react/dist/ssr";
import type { Attraction } from "@/types";

/** Shown until the administration approves the full texts; never paraphrase the official rules here. */
const SIGN_NOTE =
  "Полные правила размещены на табличке у аттракциона. Если есть вопросы по ограничениям, уточните у оператора.";

export function AttractionRules({ attraction }: { attraction: Attraction }) {
  return (
    <details className="group border-y border-grape-200">
      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-4 py-2 font-display text-base font-extrabold text-grape-800">
        Правила посещения
        <span
          aria-hidden="true"
          className="faq-plus flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sun-400 text-grape-900 transition-transform duration-200"
        >
          <Plus size={16} weight="bold" />
        </span>
      </summary>
      <div className="pb-4 text-[0.9375rem] leading-relaxed text-grape-900">
        {attraction.rules.length > 0 ? (
          <ul className="mb-3 grid gap-2">
            {attraction.rules.map((rule) => (
              <li key={rule} className="relative pl-5 before:absolute before:left-0 before:top-[0.65em] before:h-2 before:w-2 before:rounded-full before:bg-sun-400">
                {rule}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted">{SIGN_NOTE}</p>
      </div>
    </details>
  );
}
