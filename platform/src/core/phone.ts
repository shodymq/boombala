/**
 * Normalise a phone number to E.164: `+7XXXXXXXXXX` for Kazakhstan/Russia (8… and 10-digit forms accepted) or
 * `+<digits>` for other international numbers. Returns null when it is not a plausible number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+") && !digits.startsWith("7")) {
    return digits.length >= 10 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  }
  let d = digits;
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length === 11 && d.startsWith("7") ? `+${d}` : null;
}

/** Case-insensitive, whitespace-collapsed form of a name: the "same person" key together with the phone. */
export function nameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

export function cleanName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}
