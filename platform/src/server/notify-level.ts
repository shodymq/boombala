/** Kazakhstan production notifications are always non-personal; a misconfigured level fails closed to minimal. */
export const notifyLevel = (env: Record<string, string | undefined> = process.env): "full" | "minimal" => {
  if (env.PLATFORM_PROFILE === "kz-production" || env.VERCEL_ENV === "production") return "minimal";
  return env.TELEGRAM_NOTIFY_LEVEL?.trim() === "minimal" ? "minimal" : "full";
};
