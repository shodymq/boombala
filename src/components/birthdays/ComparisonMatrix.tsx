import { Check, Minus } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage, Locale } from "@/types/birthdays-v4";
import { formatNumber } from "@/lib/format";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { formatDuration } from "./shared";

const cell = "px-1 py-3 text-center align-middle md:px-4";
const label = "sticky left-0 z-10 bg-grape-800 px-2 py-3 text-left text-sm font-semibold leading-snug text-white md:px-6 md:text-base";

/** Boom is the flagship: the whole column is a light yellow strip with dark text (tokens: sun-100 / grape-900). */
const flagshipCell = (isFlagship: boolean) => (isFlagship ? "bg-sun-100 text-grape-900" : "");

function Yes({ text }: { text: string }) {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sun-400 text-grape-900" role="img" aria-label={text}>
      <Check size={15} weight="bold" aria-hidden="true" />
    </span>
  );
}

function No({ text, onFlagship }: { text: string; onFlagship?: boolean }) {
  return (
    <span className={`inline-flex h-7 w-7 items-center justify-center ${onFlagship ? "text-grape-900/45" : "text-white/45"}`} role="img" aria-label={text}>
      <Minus size={18} weight="bold" aria-hidden="true" />
    </span>
  );
}

/**
 * Comparison of the three packages (Pricing V4). Every row reads the package's own facts, so the table cannot disagree with the cards.
 * A dash means "not included in the price". The shared conditions are shown above the table, not repeated in it.
 */
export function ComparisonMatrix({ packages, locale }: { packages: BirthdayPackage[]; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const copy = (p: BirthdayPackage) => p.copy[locale];
  const flagship = (p: BirthdayPackage) => p.badge === "flagship";
  const yesNo = (on: boolean) => (on ? <Yes text={ui.included} /> : <No text={ui.notIncluded} />);
  const dash = <span aria-label={ui.notIncluded}>{ui.dash}</span>;

  const facts: { label: string; value: (p: BirthdayPackage) => React.ReactNode }[] = [
    { label: ui.rowKids, value: (p) => p.kidsIncluded },
    { label: ui.rowDurationLabel, value: (p) => formatDuration(p.durationMinutes, ui) },
    { label: ui.rowAnimators, value: (p) => (p.animatorsSelectable ? ui.animatorsSelectable(p.animators) : ui.animatorsFixed(p.animators)) },
    { label: ui.rowShow, value: (p) => (p.showCount > 0 ? p.showCount : dash) },
    {
      label: ui.rowWorkshop,
      value: (p) =>
        p.workshop ? (
          <>
            <span className="block">1</span>
            <span className="block text-[0.625rem] font-semibold leading-tight normal-case opacity-90 md:text-xs">{ui.workshopValue(p.workshop)}</span>
          </>
        ) : (
          dash
        ),
    },
    { label: ui.rowChallenge, value: (p) => yesNo(p.challengeIncluded) },
    { label: ui.welcomeRow, value: (p) => yesNo(p.welcome) },
    { label: ui.rowFigures, value: (p) => (p.figures === "included" ? <Yes text={ui.included} /> : <No text={ui.notIncluded} onFlagship={flagship(p)} />) },
    { label: ui.rowAdults, value: (p) => ui.adultsValue(p.adultsIncluded) },
    { label: ui.rowInvitation, value: (p) => yesNo(p.invitation) },
    { label: ui.rowPhoto, value: (p) => yesNo(p.photo) },
    { label: ui.rowPinata, value: (p) => yesNo(p.pinata) },
  ];

  return (
    <div className="max-w-[60rem] overflow-x-auto border-y-2 border-white/30" data-testid="comparison">
      <table className="w-full min-w-[18rem] table-fixed border-collapse text-left">
        <caption className="sr-only">{ui.compareCaption}</caption>
        <thead>
          <tr className="border-b border-white/30">
            <th scope="col" className={`${label} w-[34%] font-display text-sm font-extrabold uppercase tracking-[0.1em] text-sun-400`}>
              <span className="sr-only">{ui.packageHeader}</span>
            </th>
            {packages.map((p) => (
              <th
                key={p.id}
                scope="col"
                className={`${cell} font-display text-sm font-black uppercase leading-tight sm:text-base md:text-xl ${flagship(p) ? "w-[26%] bg-sun-100 text-grape-900" : "w-[20%] text-white"}`}
              >
                {copy(p).name.split(" ")[0]}
                <span className="block text-[0.6875rem] font-extrabold normal-case tracking-normal opacity-80 md:text-xs">
                  {copy(p).name.split(" ").slice(1).join(" ")}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/15 text-sm text-white md:text-base">
          {facts.map((row) => (
            <tr key={row.label}>
              <th scope="row" className={`${label} font-semibold`}>
                {row.label}
              </th>
              {packages.map((p) => (
                <td key={p.id} className={`${cell} font-display font-black tabular-nums ${flagshipCell(flagship(p))}`}>
                  {row.value(p)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 border-white/40">
            <th scope="row" className={`${label} font-semibold`}>
              {ui.rowPriceRegular}
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black tabular-nums ${flagshipCell(flagship(p))}`}>
                {formatNumber(p.weekendPrice)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className={`${label} font-semibold`}>
              {ui.rowPriceWeekday}
            </th>
            {packages.map((p) => (
              <td
                key={p.id}
                className={`${cell} font-display font-black tabular-nums ${flagship(p) ? "text-grape-900" : "text-sun-400"} ${flagshipCell(flagship(p))}`}
              >
                {formatNumber(p.weekdayPrice)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className={`${label} font-semibold`}>
              {ui.rowSavings}
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black tabular-nums ${flagshipCell(flagship(p))}`}>
                {formatNumber(p.weekdaySavings)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className={`${label} font-semibold`}>
              {ui.rowDiscountExtra}
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black tabular-nums ${flagshipCell(flagship(p))}`}>
                −{p.extraChildDiscountPct}%
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
