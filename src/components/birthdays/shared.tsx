import type { BirthdayPackage, Locale, ProgramItem } from "@/types";
import type { BirthdaysUi } from "@/data/birthdays-ui";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";

/** Titles that already say the item is a choice ("... на выбор", "... таңдау бойынша"): no extra "1 на выбор" label is added. */
export const isChoiceTitle = (title: string): boolean => /на выбор|таңдау бойынша/i.test(title);

/** Approved badge labels only. Nothing says "most popular" (there is no data for it). */
export function badgeLabel(pkg: BirthdayPackage, locale: Locale): string | null {
  const ui = BIRTHDAYS_UI[locale];
  if (pkg.badge === "optimal") return ui.badgeOptimal;
  if (pkg.badge === "flagship") return ui.badgeFlagship;
  return null;
}

/**
 * The programme as written in Pricing V3. A choice item shows "1 на выбор" and its options, and never reads as if all were included.
 * `chipClass` styles the options; `lineClass` and `muted` style the rows.
 */
export function ProgramList({
  items,
  ui,
  chipClass,
  lineClass,
  muted,
}: {
  items: ProgramItem[];
  ui: BirthdaysUi;
  chipClass: string;
  lineClass: string;
  muted: string;
}) {
  return (
    <ul className={`divide-y ${lineClass}`}>
      {items.map((item) => (
        <li key={item.title} className="py-3">
          <p className="font-display text-base font-extrabold leading-snug">
            {item.title}
            {item.choice && !isChoiceTitle(item.title) ? <span className={`ml-2 text-sm font-bold ${muted}`}>({ui.choiceNote})</span> : null}
          </p>
          {item.detail ? <p className={`mt-0.5 text-sm leading-relaxed ${muted}`}>{item.detail}</p> : null}
          {item.choice && item.options.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {item.options.map((o) => (
                <li key={o} className={`rounded-full border px-3 py-1 text-sm font-medium ${chipClass}`}>
                  {o}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
