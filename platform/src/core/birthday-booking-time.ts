const BIRTHDAY_DURATION_MINUTES = 4 * 60;

export function birthdayStartTimes(workingHours: string): string[] {
  const match = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(workingHours);
  if (!match) return [];

  const [openHour, openMinute, closeHour, closeMinute] = match.slice(1).map(Number);
  if (openHour > 23 || closeHour > 24 || openMinute > 59 || closeMinute > 59 || (closeHour === 24 && closeMinute !== 0)) return [];

  const opensAt = openHour * 60 + openMinute;
  const closesAt = closeHour * 60 + closeMinute;
  if (opensAt >= closesAt) return [];

  const firstHour = Math.ceil(opensAt / 60);
  const lastStart = closesAt - BIRTHDAY_DURATION_MINUTES;
  const times: string[] = [];
  for (let minute = firstHour * 60; minute <= lastStart; minute += 60) {
    times.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:00`);
  }
  return times;
}

export function hasBirthdayDuration(startsAt: string | null, endsAt: string | null): boolean {
  const start = Date.parse(startsAt ?? "");
  const end = Date.parse(endsAt ?? "");
  return Number.isFinite(start) && end === start + BIRTHDAY_DURATION_MINUTES * 60 * 1000;
}

export function hasBirthdayStart(startsAt: string | null, date: string, startTime: string): boolean {
  const value = startsAt ?? "";
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false;

  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/i)?.[1];
  if (fraction && /[1-9]/.test(fraction)) return false;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;

  const start = new Date(timestamp);
  if (start.getUTCMilliseconds() !== 0) return false;

  const local = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(start)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}` === `${date}T${startTime}` && local.second === "00";
}
