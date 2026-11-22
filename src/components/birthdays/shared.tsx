import type { BirthdayPackage, Locale, ProgramItem } from "@/types/birthdays-v4";
import type { BirthdaysUi } from "@/data/birthdays-ui";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";


/** "1 час", "1,5 часа" style text for a programme length (the same numbers as the approved table). */
export function formatDuration(minutes: number, ui: BirthdaysUi): string {
  if (minutes % 60 === 0) return `${minutes / 60} ${ui.hourShort}`;
  return `${(minutes / 60).toString().replace(".", ",")} ${ui.hourShort}`;
}

/** Approved badge labels only. Nothing says "most popular" (there is no data for it). */
export function badgeLabel(pkg: BirthdayPackage, locale: Locale): string | null {
  const ui = BIRTHDAYS_UI[locale];
  if (pkg.badge === "optimal") return ui.badgeOptimal;
  if (pkg.badge === "flagship") return ui.badgeFlagship;
  return null;
}

/**
 * The programme as written in Pricing V4.2. A choice item shows "1 на выбор" and its options, and never reads as if all were included.
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
          </p>
          <p className={`mt-1 text-sm font-bold ${muted}`}>
            {item.pick > 0 ? ui.chooseN(item.pick) : null}
            {item.pick > 0 && item.minutes ? " · " : null}
            {item.minutes ? `${item.minutes} ${ui.minShort}` : null}
          </p>
          {item.detail ? <p className={`mt-0.5 text-sm leading-relaxed ${muted}`}>{item.detail}</p> : null}
          {item.optionsNote ? <p className={`mt-1 text-sm ${muted}`}>{item.optionsNote}</p> : null}
          {item.pick > 0 && item.options.length ? (
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

/** The three numbers every card shows first: children, length of the programme, animators. Large, one line each. */
export function StatStrip({ pkg, ui, tone = "light" }: { pkg: BirthdayPackage; ui: BirthdaysUi; tone?: "light" | "dark" | "flagship" }) {
  const box = tone === "flagship" ? "bg-grape-800 text-sun-400" : tone === "dark" ? "bg-white/10 text-white" : "bg-grape-50 text-grape-800";
  const cells = [
    { value: String(pkg.kidsIncluded), label: ui.statKids },
    { value: formatDuration(pkg.durationMinutes, ui), label: ui.statProgramme },
    { value: String(pkg.animators), label: pkg.animatorsSelectable ? ui.statAnimatorsChoice : ui.statAnimators },
  ];
  return (
    <dl className={`mt-5 grid grid-cols-3 gap-2 rounded-3xl p-3 text-center ${box}`} data-testid="stat-strip">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-col justify-center py-2">
          <dd className="font-display text-3xl font-black leading-none tabular-nums md:text-4xl">{c.value}</dd>
          <dt className="mt-1 text-xs font-bold leading-tight opacity-90 md:text-sm">{c.label}</dt>
        </div>
      ))}
    </dl>
  );
}
