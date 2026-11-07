"use client";

import { useEffect, useRef, useState } from "react";
import { FlaticonIcon } from "@/components/flaticon-icon";
import { almatyToday } from "@/core/dates";

type DateParts = { year: number; month: number; day: number };

function parseDate(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month: month - 1, day }
    : null;
}

function dateValue(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDate(value: string): string {
  const parts = parseDate(value);
  if (!parts) return "Выберите дату";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(parts.year, parts.month, parts.day)));
}

function monthDays(year: number, month: number) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const mondayOffset = (firstWeekday + 6) % 7;
  const firstCell = new Date(Date.UTC(year, month, 1 - mondayOffset));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell);
    date.setUTCDate(firstCell.getUTCDate() + index);
    return {
      value: dateValue(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      day: date.getUTCDate(),
      inMonth: date.getUTCMonth() === month,
    };
  });
}

function changeMonth(year: number, month: number, amount: number): DateParts {
  const date = new Date(Date.UTC(year, month + amount, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: 1 };
}

export function DatePicker({
  name,
  label,
  defaultValue = "",
  className = "",
  allowClear = true,
  required = false,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  className?: string;
  allowClear?: boolean;
  required?: boolean;
}) {
  const [value, setValue] = useState(parseDate(defaultValue) ? defaultValue : "");
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState<DateParts | null>(null);
  const [activeDate, setActiveDate] = useState("");
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const root = useRef<HTMLDivElement>(null);
  const today = almatyToday();
  const selected = parseDate(value);
  const month = visibleMonth ?? selected ?? parseDate(today)!;
  const monthName = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(month.year, month.month, 1)));
  const title = `${monthName[0].toLocaleUpperCase("ru-RU")}${monthName.slice(1)} ${month.year}`;

  const openPicker = () => {
    const initial = selected ?? parseDate(today)!;
    setVisibleMonth(initial);
    setActiveDate(value || today);
    const bounds = root.current?.getBoundingClientRect();
    setPlacement(bounds && window.innerHeight - bounds.bottom < 340 && bounds.top > 340 ? "top" : "bottom");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>(`[data-date="${activeDate}"]`)?.focus();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, activeDate]);

  const moveDate = (current: string, amount: number) => {
    const parts = parseDate(current);
    if (!parts) return;
    const date = new Date(Date.UTC(parts.year, parts.month, parts.day + amount));
    const next = dateValue(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const nextParts = parseDate(next)!;
    setActiveDate(next);
    if (nextParts.year !== month.year || nextParts.month !== month.month) setVisibleMonth(nextParts);
  };

  return (
    <div className={`crm-date-picker ${className}`} ref={root} onSubmitCapture={(event) => {
      if (required && !value) {
        event.preventDefault();
        openPicker();
      }
    }} onBlur={(event) => {
      if (!(event.relatedTarget instanceof Node) || !root.current?.contains(event.relatedTarget)) setOpen(false);
    }}>
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        className="crm-date-picker-trigger"
        aria-label={required ? `${label}, обязательно` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => open ? setOpen(false) : openPicker()}
      >
        <span>{formatDate(value)}</span>
        <FlaticonIcon name="calendar" size={16} />
      </button>
      {open ? (
        <div className="crm-date-picker-popover" data-placement={placement} role="dialog" aria-label="Выбор даты" onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            root.current?.querySelector<HTMLButtonElement>(".crm-date-picker-trigger")?.focus();
            return;
          }
          const movement: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
          if (movement[event.key]) {
            event.preventDefault();
            moveDate(activeDate, movement[event.key]);
          }
        }}>
          <div className="crm-date-picker-heading">
            <button type="button" aria-label="Предыдущий месяц" onClick={() => {
              const next = changeMonth(month.year, month.month, -1);
              setVisibleMonth(next);
              setActiveDate(dateValue(next.year, next.month, 1));
            }}><FlaticonIcon name="chevron-right" size={14} className="crm-date-arrow crm-date-arrow-prev" /></button>
            <strong>{title}</strong>
            <button type="button" aria-label="Следующий месяц" onClick={() => {
              const next = changeMonth(month.year, month.month, 1);
              setVisibleMonth(next);
              setActiveDate(dateValue(next.year, next.month, 1));
            }}><FlaticonIcon name="chevron-right" size={14} className="crm-date-arrow" /></button>
          </div>
          <div className="crm-date-picker-weekdays" aria-hidden="true">
            {(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]).map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="crm-date-picker-days">
            {monthDays(month.year, month.month).map((day) => (
              <button
                key={day.value}
                type="button"
                className={[
                  day.inMonth ? "" : "is-outside",
                  day.value === value ? "is-selected" : "",
                  day.value === today ? "is-today" : "",
                ].filter(Boolean).join(" ")}
                data-date={day.value}
                tabIndex={day.value === activeDate ? 0 : -1}
                aria-label={formatDate(day.value)}
                aria-current={day.value === today ? "date" : undefined}
                onClick={() => { setValue(day.value); setActiveDate(day.value); setOpen(false); }}
              >
                {day.day}
              </button>
            ))}
          </div>
          <div className="crm-date-picker-footer">
            {allowClear && value ? <button type="button" onClick={() => { setValue(""); setOpen(false); }}>Очистить</button> : <span />}
            <button type="button" onClick={() => { setValue(today); setOpen(false); }}>Сегодня</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
