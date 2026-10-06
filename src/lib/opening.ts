import { siteConfig } from "@/services/config";

/**
 * before  — until 7 Oct 12:00        ("Начинаем работу 7 октября в 12:00" + countdown)
 * working — 7 Oct 12:00 .. 24 Oct 10:00 ("BOOM BALA уже работает")
 * open    — from 24 Oct 10:00        ("BOOM BALA открыт")
 */
export type OpeningPhase = "before" | "working" | "open";

export type OpeningState =
  | { kind: "before"; label: string; ms?: number }
  | { kind: "working"; label: string }
  | { kind: "open"; label: string };

const { timeZone, utcOffset } = siteConfig.opening;

const at = (date: string, time: string) => new Date(`${date}T${time}:00${utcOffset}`).getTime();
const startAt = () => at(siteConfig.opening.date, siteConfig.opening.time);
const grandAt = () => at(siteConfig.grandOpening.date, siteConfig.grandOpening.time);

/** "7 октября" */
function dayLabel(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00${utcOffset}`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone,
  });
}

/** "7 октября" (start of work) */
export function openingDateLabel(): string {
  return dayLabel(siteConfig.opening.date);
}

/** "7 октября 2026 года в 12:00" */
function fullLabel(isoDate: string, time: string): string {
  return `${dayLabel(isoDate)} ${isoDate.slice(0, 4)} года в ${time}`;
}

/** "7 октября 2026 года в 12:00" (start of work) */
export function startFullLabel(): string {
  return fullLabel(siteConfig.opening.date, siteConfig.opening.time);
}

/** "24 октября 2026 года в 10:00" (big opening) */
export function grandOpeningFullLabel(): string {
  return fullLabel(siteConfig.grandOpening.date, siteConfig.grandOpening.time);
}

/** "24 октября" (big opening day) */
export function grandOpeningDayLabel(): string {
  return dayLabel(siteConfig.grandOpening.date);
}

/** "Начинаем работу 7 октября в 12:00" */
export function startLabel(): string {
  return `Начинаем работу ${dayLabel(siteConfig.opening.date)} в ${siteConfig.opening.time}`;
}

/** "Большое открытие — 24 октября в 10:00" */
export function grandOpeningLabel(): string {
  return `Большое открытие — ${dayLabel(siteConfig.grandOpening.date)} в ${siteConfig.grandOpening.time}`;
}

export function getOpeningPhase(now: number = Date.now()): OpeningPhase {
  if (now >= grandAt()) return "open";
  if (now >= startAt()) return "working";
  return "before";
}

/** Static state for SSR / before hydration (always the "before" wording, no ticking clock). */
export function staticOpeningState(): OpeningState {
  return { kind: "before", label: startLabel() };
}

export function getOpeningState(now: number = Date.now()): OpeningState {
  const phase = getOpeningPhase(now);
  if (phase === "open") return { kind: "open", label: "BOOM BALA открыт" };
  if (phase === "working") return { kind: "working", label: "BOOM BALA уже работает" };
  return { kind: "before", label: startLabel(), ms: startAt() - now };
}
