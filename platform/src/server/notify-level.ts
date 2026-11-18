/**
 * Full notifications include customer contact details. In the Kazakhstan production profile
 * they require an explicit, separate acknowledgement in addition to the selected level.
 */
export const notifyLevel = (): "full" | "minimal" => {
  if (process.env.PLATFORM_PROFILE === "kz-production") {
    return process.env.TELEGRAM_NOTIFY_LEVEL === "full" && process.env.TELEGRAM_FULL_PII_ACK === "1"
      ? "full"
      : "minimal";
  }
  return process.env.TELEGRAM_NOTIFY_LEVEL === "minimal" ? "minimal" : "full";
};
