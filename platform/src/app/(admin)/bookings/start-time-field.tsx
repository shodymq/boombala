"use client";

import { useId, useRef, useState } from "react";
import { endTimeFor } from "../../../core/booking-calendar.ts";

/**
 * New bookings start on the hour. Existing reservations may still render at their stored exact time in the calendar.
 * The end is derived (start + 240 min) and shown, but it is never submitted: the server computes it.
 */
export function StartTimeField({ name = "startTime", defaultValue, quick, label = "Начало" }: { name?: string; defaultValue: string; quick: string[]; label?: string }) {
  const [value, setValue] = useState(defaultValue);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const end = endTimeFor(value);
  const chooseTime = (next: string, input = inputRef.current) => {
    setValue(next);
    input?.setCustomValidity(next && !/^\d{2}:00$/.test(next) ? "Выберите начало в полный час." : "");
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-extrabold text-muted">{label} (полный час)</label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="time"
          step={3600}
          required
          value={value}
          onChange={(e) => chooseTime(e.target.value, e.currentTarget)}
          className="h-11 w-32 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none"
        />
        <p className="text-sm font-bold text-grape-900" aria-live="polite" data-end-time>{end ? `до ${end} (4 часа)` : "Введите время ЧЧ:ММ"}</p>
      </div>
      {quick.length > 0 ? (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="group" aria-label="Выбор времени по часам">
          {quick.map((q) => (
          <button key={q} type="button" onClick={() => chooseTime(q)} aria-pressed={q === value} className={`h-8 rounded-full border px-2 text-xs font-extrabold max-md:min-h-11 max-md:min-w-11 max-md:px-3 ${q === value ? "border-grape-700 bg-grape-700 text-white" : "border-grape-200 text-grape-700 hover:bg-grape-50"}`}>
              {q}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
