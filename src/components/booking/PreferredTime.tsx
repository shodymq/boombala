"use client";

import { BOOKING_SLOTS } from "@/lib/lead";
import type { Locale } from "@/types";

const TIME_COPY: Record<Locale, { label: string; optional: string; hint: string }> = {
  ru: { label: "Предпочитаемое время", optional: "(по желанию)", hint: "Желаемое время. Менеджер подтвердит доступность." },
  kk: { label: "Қалаған уақыт", optional: "(қаласаңыз)", hint: "Қалаған уақыт. Менеджер қолжетімділікті растайды." },
};

/**
 * Preferred time of the party, shown while the availability calendar is OFF (NEXT_PUBLIC_BOOKING_CALENDAR is not "1").
 * It reads nothing and claims nothing: no free rooms, no free dates, no prices. It only records a wish that the enquiry
 * carries to the manager, who confirms availability. The full AvailabilityPanel replaces it once the CRM is connected.
 */
export function PreferredTime({ slot, onSlot, locale = "ru" }: { slot: string; onSlot: (id: string) => void; locale?: Locale }) {
  const c = TIME_COPY[locale];
  return (
    <div className="grid gap-2 rounded-2xl border-2 border-grape-200 bg-grape-50 p-4" data-testid="preferred-time">
      <p className="font-display text-sm font-extrabold text-grape-800">
        {c.label} <span className="font-medium text-muted">{c.optional}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={c.label}>
        {BOOKING_SLOTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={slot === s.id}
            data-preferred-slot={s.id}
            onClick={() => onSlot(slot === s.id ? "" : s.id)}
            className={`min-h-12 rounded-xl border-2 px-3 py-2 text-left text-sm font-bold ${slot === s.id ? "border-grape-700 bg-grape-700 text-white" : "border-grape-200 bg-white text-grape-900"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{c.hint}</p>
    </div>
  );
}
