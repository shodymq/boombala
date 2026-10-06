import { Check, Minus } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage, ProgramKey } from "@/types";
import { formatNumber } from "@/lib/format";

interface RowDef {
  label: string;
  key: ProgramKey;
  /** Render the count ("1", "2") instead of a check mark. */
  showCount?: boolean;
}

const rows: RowDef[] = [
  { label: "Торжественное поздравление", key: "greeting" },
  { label: "Анимационная программа", key: "animation" },
  { label: "Мастер-класс", key: "workshop" },
  { label: "Квест", key: "quest" },
  { label: "Шоу на выбор", key: "shows", showCount: true },
  { label: "2 аниматора", key: "animators" },
  { label: "Встреча ростовыми куклами", key: "characters" },
  { label: "Челлендж", key: "challenge" },
  { label: "Праздничная пиньята", key: "pinata" },
];

const cell = "px-1 py-3 text-center align-middle md:px-4";

function Yes() {
  return (
    <span
      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sun-400 text-grape-900"
      role="img"
      aria-label="Входит"
    >
      <Check size={15} weight="bold" aria-hidden="true" />
    </span>
  );
}

function No() {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center text-white/35" role="img" aria-label="Не входит">
      <Minus size={18} weight="bold" aria-hidden="true" />
    </span>
  );
}

export function ComparisonMatrix({ packages }: { packages: BirthdayPackage[] }) {
  return (
    <div className="max-w-[60rem] border-y-2 border-white/30">
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">Сравнение праздничных пакетов Boom Bala</caption>
        <colgroup>
          <col />
          {packages.map((p) => (
            <col key={p.id} className="w-[4.5rem] sm:w-28 md:w-40" />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-white/30">
            <th scope="col" className="px-4 py-4 font-display text-sm font-extrabold uppercase tracking-[0.1em] text-sun-400 md:px-6">
              Пакет
            </th>
            {packages.map((p) => (
              <th
                key={p.id}
                scope="col"
                className={`${cell} font-display text-sm font-black text-white sm:text-base md:text-xl ${p.id === "boom-party" ? "bg-sun-400 !text-grape-900" : ""}`}
              >
                {p.shortName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/15 text-sm text-white md:text-base">
          <tr>
            <th scope="row" className="px-4 py-3 font-semibold text-white md:px-6">
              Цена, ₸
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black tabular-nums text-white ${p.id === "boom-party" ? "bg-white/10" : ""}`}>
                {formatNumber(p.price)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-4 py-3 font-semibold text-white md:px-6">
              В будни −30%
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black tabular-nums text-sun-400 ${p.id === "boom-party" ? "bg-white/10" : ""}`}>
                {formatNumber(p.weekdayPrice)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-4 py-3 font-semibold text-white md:px-6">
              Именинник + бесплатно
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} font-display font-black text-white ${p.id === "boom-party" ? "bg-white/10" : ""}`}>
                {p.freeChildren} детей
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-4 py-3 font-semibold text-white md:px-6">
              −20% на вход доп. гостям
            </th>
            {packages.map((p) => (
              <td key={p.id} className={`${cell} ${p.id === "boom-party" ? "bg-white/10" : ""}`}>
                <Yes />
              </td>
            ))}
          </tr>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="px-4 py-3 font-semibold text-white md:px-6">
                {row.label}
              </th>
              {packages.map((p) => {
                const item = p.program.find((i) => i.key === row.key);
                return (
                  <td key={p.id} className={`${cell} ${p.id === "boom-party" ? "bg-white/10" : ""}`}>
                    {!item ? (
                      <No />
                    ) : row.showCount && item.count ? (
                      <span className="font-display text-lg font-black text-sun-400">{item.count}</span>
                    ) : (
                      <Yes />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
