"use client";

import { useId, useState } from "react";
import { endTimeFor } from "../../../core/booking-calendar.ts";

/**
 * Start time to the exact minute. The 15-minute chips are a shortcut; the time input accepts any HH:MM and nothing is rounded.
 * The end is derived (start + 240 min) and shown, but it is never submitted: the server computes it.
 */
export function StartTimeField({ name = "startTime", defaultValue, quick, label = "Начало" }: { name?: string; defaultValue: string; quick: string[]; label?: string }) {
  const [value, setValue] = useState(defaultValue);
  const id = useId();
  const end = endTimeFor(value);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-extrabold text-muted">{label} (любая минута)</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type="time"
          step={60}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-11 w-32 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none"
        />
        <p className="text-sm font-bold text-grape-900" aria-live="polite" data-end-time>{end ? `до ${end} (4 часа)` : "Введите время ЧЧ:ММ"}</p>
      </div>
      {quick.length > 0 ? (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="group" aria-label="Быстрый выбор с шагом 15 минут">
          {quick.map((q) => (
            <button key={q} type="button" onClick={() => setValue(q)} aria-pressed={q === value} className={`h-8 rounded-full border px-2 text-xs font-extrabold ${q === value ? "border-grape-700 bg-grape-700 text-white" : "border-grape-200 text-grape-700 hover:bg-grape-50"}`}>
              {q}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
