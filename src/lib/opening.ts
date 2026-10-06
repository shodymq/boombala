import { siteConfig } from "@/services/config";

export type OpeningState =
  | { kind: "upcoming"; label: string }
  | { kind: "countdown"; label: string; ms: number }
  | { kind: "today"; label: string }
  | { kind: "open"; label: string };

const { date, time, timeZone, utcOffset } = siteConfig.opening;

/** "7 октября" */
export function openingDateLabel(): string {
  return new Date(`${date}T00:00:00${utcOffset}`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone,
  });
}

/** Static state for SSR / before hydration. */
export function staticOpeningState(): OpeningState {
  return { kind: "upcoming", label: `Открытие — ${openingDateLabel()}` };
}

/**
 * - exact time set  -> countdown until it, then "open"
 * - no time yet     -> date only; "today" on the day, "open" after it
 */
export function getOpeningState(now: number = Date.now()): OpeningState {
  const dateLabel = openingDateLabel();

  if (time) {
    const target = new Date(`${date}T${time}:00${utcOffset}`).getTime();
    if (now >= target) return { kind: "open", label: "BOOM BALA уже открыт" };
    return { kind: "countdown", label: `Открытие — ${dateLabel}`, ms: target - now };
  }

  const dayStart = new Date(`${date}T00:00:00${utcOffset}`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  if (now >= dayEnd) return { kind: "open", label: "BOOM BALA уже открыт" };
  if (now >= dayStart) return { kind: "today", label: "Открытие — сегодня" };
  return { kind: "upcoming", label: `Открытие — ${dateLabel}` };
}
