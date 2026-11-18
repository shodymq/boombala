/** The deployment profile validates the explicit setting; minimal is available, and full preserves the owner-approved detailed format. */
export const notifyLevel = (): "full" | "minimal" =>
  process.env.TELEGRAM_NOTIFY_LEVEL?.trim() === "minimal" ? "minimal" : "full";
