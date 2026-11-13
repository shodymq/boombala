const BIRTHDAY_DURATION_MINUTES = 4 * 60;

export function birthdayStartTimes(workingHours: string): string[] {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(workingHours);
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
