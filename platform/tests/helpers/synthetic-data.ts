let phoneLine = 100;

/** A non-working fictional NANPA 555-0100–0199 line, generated only inside test processes. */
export function syntheticPhone(): string {
  if (phoneLine > 199) throw new Error("synthetic_phone_fixture_range_exhausted");
  const line = String(phoneLine++).padStart(4, "0");
  return `+${1}${202}${555}${line}`;
}
