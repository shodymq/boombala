"use client";

import { LATE_START_FROM, PREFERRED_START_TIMES, needsManagerForStart } from "@/lib/lead";
import type { Locale } from "@/types";

const TIME_COPY: Record<Locale, { label: string; optional: string; placeholder: string; hint: string; late: string }> = {
  ru: {
    label: "Желаемое время начала",
    optional: "(по желанию)",
    placeholder: "Не выбрано",
    hint: "Это пожелание, не бронь. Менеджер подтвердит свободное время и стоимость.",
    late: `Старт с ${LATE_START_FROM}: программа 4 часа не помещается до 22:00. Менеджер уточнит возможность отдельно.`,
  },
  kk: {
    label: "Бастау уақыты қалаған",
    optional: "(қаласаңыз)",
    placeholder: "Таңдалмаған",
    hint: "Бұл тілек, брондау емес. Менеджер бос уақыт пен бағаны растайды.",
    late: `${LATE_START_FROM}-ден бастау: 4 сағаттық бағдарлама 22:00-ге дейін сыймайды. Менеджер мүмкіндігін бөлек нақтылайды.`,
  },
};

/**
 * Wished START time of the party, in one-hour steps from 10:00 to 22:00. Shown while the availability calendar is OFF.
 * It reads nothing and claims nothing: no free rooms, no free dates, no prices. It records a wish that the enquiry carries to
 * the manager, who confirms availability. It is NOT a booking slot and never sets the legacy slot id.
 */
export function PreferredTime({ id, value, onChange, locale = "ru" }: { id?: string; value: string; onChange: (time: string) => void; locale?: Locale }) {
  const c = TIME_COPY[locale];
  const late = value !== "" && needsManagerForStart(value);
  const selectId = id ?? "preferred-start-time";
  return (
    <div className="grid gap-2 rounded-2xl border-2 border-grape-200 bg-grape-50 p-4" data-testid="preferred-time">
      <label htmlFor={selectId} className="font-display text-sm font-extrabold text-grape-800">
        {c.label} <span className="font-medium text-muted">{c.optional}</span>
      </label>
      <select
        id={selectId}
        name="preferredStartTime"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${selectId}-hint`}
        className="min-h-12 w-full rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none sm:w-64"
      >
        <option value="">{c.placeholder}</option>
        {PREFERRED_START_TIMES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <p id={`${selectId}-hint`} className="text-xs text-muted">
        {c.hint}
      </p>
      {late ? (
        <p role="note" className="text-sm font-semibold text-grape-800" data-testid="preferred-time-late">
          {c.late}
        </p>
      ) : null}
    </div>
  );
}
