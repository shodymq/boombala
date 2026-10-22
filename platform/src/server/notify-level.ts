/** In the Kazakhstan production profile the level is `minimal` whatever the environment says (the profile also refuses to start otherwise). */
export const notifyLevel = (): "full" | "minimal" =>
  process.env.PLATFORM_PROFILE === "kz-production" || process.env.TELEGRAM_NOTIFY_LEVEL === "minimal" ? "minimal" : "full";
