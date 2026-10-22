"use client";

import { BOOKING_SLOTS } from "@/lib/lead";

/**
 * Preferred time of the party, shown while the availability calendar is OFF (NEXT_PUBLIC_BOOKING_CALENDAR is not "1").
 * It reads nothing and claims nothing: no free rooms, no free dates, no prices. It only records a wish that the enquiry
 * carries to the manager, who confirms availability. The full AvailabilityPanel replaces it once the CRM is connected.
 */
export function PreferredTime({ slot, onSlot }: { slot: string; onSlot: (id: string) => void }) {
  return (
    <div className="grid gap-2 rounded-2xl border-2 border-grape-200 bg-grape-50 p-4" data-testid="preferred-time">
      <p className="font-display text-sm font-extrabold text-grape-800">Предпочитаемое время <span className="font-medium text-muted">(по желанию)</span></p>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Предпочитаемое время">
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
      <p className="text-xs text-muted">Желаемое время. Менеджер подтвердит доступность.</p>
    </div>
  );
}
