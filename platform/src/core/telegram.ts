/**
 * Telegram delivery for CRM notifications. The token never leaves this module: it is not logged, not put in thrown
 * errors and not returned to callers. Transport is injectable so tests use a local mock server.
 */
export type TelegramErrorCode = "not_configured" | "timeout" | "network" | "rejected" | "rate_limited" | "bad_response";

export class TelegramError extends Error {
  readonly code: TelegramErrorCode;
  readonly status: number | null;
  constructor(code: TelegramErrorCode, status: number | null = null) {
    super(`telegram:${code}${status ? `:${status}` : ""}`);
    this.name = "TelegramError";
    this.code = code;
    this.status = status;
  }
}

export interface TelegramConfig {
  token: string;
  chatId: string;
  apiBase: string;
}

const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();

export function telegramConfigFromEnv(env: Record<string, string | undefined> = process.env): TelegramConfig | null {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) return null;
  return { token, chatId, apiBase: clean(env.TELEGRAM_API_BASE) || "https://api.telegram.org" };
}

/** Plain text on purpose (no parse_mode): nothing to escape, nothing user-controlled can become markup. */
export async function sendTelegram(config: TelegramConfig | null, text: string, timeoutMs = 8000): Promise<void> {
  if (!config) throw new TelegramError("not_configured");
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    // The original error message can contain the request URL (and therefore the token): drop it.
    throw new TelegramError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
  }
  let payload: { ok?: boolean } | null = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok && payload?.ok === true) return;
  if (res.status === 429) throw new TelegramError("rate_limited", 429);
  if (!payload) throw new TelegramError("bad_response", res.status);
  throw new TelegramError("rejected", res.status);
}

export interface LeadNotification {
  seq: number;
  name: string;
  phone: string;
  date: string; // YYYY-MM-DD
  children: number | null;
  packageName: string | null;
  roomName: string | null;
  slotLabel: string | null;
  consentVersion: number | null;
  page: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  createdAt: Date;
}

const dash = (v: string | number | null | undefined) => (v === null || v === undefined || String(v).trim() === "" ? "—" : String(v).trim());
const ruDate = (iso: string) => iso.split("-").reverse().join(".");
const prettyPhone = (p: string) => {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(p);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
};
const almatyTime = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/**
 * `full` keeps today's message (name and phone included, as the existing process does). `minimal` omits personal data:
 * Telegram is a third-party service, so which level is used is a decision for the owner (see the privacy policy).
 */
export function buildLeadMessage(n: LeadNotification, level: "full" | "minimal"): string {
  if (level === "minimal") {
    return ["🎂 Новая заявка — BOOM BALA", `CRM №${n.seq}`, `Дата: ${ruDate(n.date)}`, `Пакет: ${dash(n.packageName)}`, "Подробности в CRM."].join("\n");
  }
  return [
    "🎂 НОВАЯ ЗАЯВКА — BOOM BALA",
    `CRM №${n.seq}`,
    "",
    `Имя: ${dash(n.name)}`,
    `Телефон: ${dash(prettyPhone(n.phone))}`,
    `Дата: ${ruDate(n.date)}`,
    `Детей: ${dash(n.children)}`,
    `Пакет: ${dash(n.packageName)}`,
    `Предпочитаемая комната: ${dash(n.roomName)}`,
    `Предпочитаемый слот: ${dash(n.slotLabel)}`,
    "",
    `Согласие на обработку данных: да (редакция ${dash(n.consentVersion)})`,
    "Источник: website",
    `Страница: ${dash(n.page)}`,
    `Referrer: ${dash(n.referrer)}`,
    `UTM source: ${dash(n.utmSource)}`,
    `UTM medium: ${dash(n.utmMedium)}`,
    `UTM campaign: ${dash(n.utmCampaign)}`,
    "",
    `Время: ${almatyTime(n.createdAt)}`,
    "Алматы",
  ].join("\n");
}
