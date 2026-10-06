import "server-only";
import { siteConfig } from "@/services/config";

/**
 * Server-only Telegram delivery. The bot token never leaves this module:
 * it is not logged, not put in thrown errors and not returned to callers.
 */

export type TelegramErrorKind =
  | "not_configured" // token or chat id missing/empty
  | "rejected" // Telegram answered with ok:false or a 4xx/5xx status
  | "network" // timeout / DNS / connection failure
  | "bad_response"; // answer was not valid JSON

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  /** HTTP status of Telegram's response, if any. */
  readonly status?: number;
  /** Telegram's own error_code (e.g. 400, 401, 403). */
  readonly telegramCode?: number;
  /** Telegram's description (safe to log; contains no token). */
  readonly description?: string;

  constructor(kind: TelegramErrorKind, details: { status?: number; telegramCode?: number; description?: string } = {}) {
    super(`telegram:${kind}${details.description ? `:${details.description}` : ""}`);
    this.name = "TelegramError";
    this.kind = kind;
    this.status = details.status;
    this.telegramCode = details.telegramCode;
    this.description = details.description;
  }

  /** Short UPPER_SNAKE label for logs, e.g. "CHAT_NOT_FOUND", "UNAUTHORIZED". */
  get label(): string {
    if (this.kind !== "rejected") return this.kind.toUpperCase();
    const d = (this.description ?? "").toLowerCase();
    if (d.includes("chat not found")) return "CHAT_NOT_FOUND";
    if (d.includes("unauthorized") || this.telegramCode === 401) return "UNAUTHORIZED";
    if (d.includes("can't initiate conversation") || d.includes("bot was blocked")) return "USER_HAS_NOT_STARTED_BOT";
    if (d.includes("kicked") || d.includes("not a member")) return "BOT_NOT_IN_CHAT";
    if (d.includes("not enough rights") || d.includes("have no rights")) return "NO_RIGHTS_TO_SEND";
    if (d.includes("too many requests")) return "TELEGRAM_RATE_LIMITED";
    return `TELEGRAM_${this.telegramCode ?? this.status ?? "ERROR"}`;
  }
}

/** Strip whitespace and accidental wrapping quotes from an env value. */
function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

export function telegramConfig(): { token: string; chatId: string; apiBase: string } | null {
  const token = clean(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(process.env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) return null;
  return { token, chatId, apiBase: clean(process.env.TELEGRAM_API_BASE) || "https://api.telegram.org" };
}

/** Safe-to-log configuration summary. Never includes values. */
export function telegramDiagnostics() {
  return {
    telegramTokenConfigured: Boolean(clean(process.env.TELEGRAM_BOT_TOKEN)),
    telegramChatIdConfigured: Boolean(clean(process.env.TELEGRAM_CHAT_ID)),
  };
}

export interface LeadMessage {
  name: string;
  /** Normalised, e.g. +77771234567 */
  phone: string;
  /** YYYY-MM-DD */
  date: string;
  children: number | null;
  packageLabel: string;
  page: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
}

const dash = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : "—";
};

/** +77771234567 -> "+7 777 123 45 67"; anything else is left as entered. */
function prettyPhone(phone: string): string {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

const ruDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

function almatyTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: siteConfig.opening.timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}.${g("month")}.${g("year")} ${g("hour")}:${g("minute")}`;
}

/** Plain text on purpose: no parse_mode means no escaping pitfalls with user input. */
export function buildLeadText(lead: LeadMessage): string {
  return [
    "🎂 НОВАЯ ЗАЯВКА — BOOM BALA",
    "",
    `Имя: ${dash(lead.name)}`,
    `Телефон: ${dash(prettyPhone(lead.phone))}`,
    `Дата: ${lead.date ? ruDate(lead.date) : "—"}`,
    `Детей: ${dash(lead.children)}`,
    `Пакет: ${dash(lead.packageLabel)}`,
    "",
    "Согласие на обработку данных: да",
    "Источник: website",
    `Страница: ${dash(lead.page)}`,
    `Referrer: ${dash(lead.referrer)}`,
    `UTM source: ${dash(lead.utmSource)}`,
    `UTM medium: ${dash(lead.utmMedium)}`,
    `UTM campaign: ${dash(lead.utmCampaign)}`,
    "",
    `Время: ${almatyTimestamp()}`,
    "Алматы",
  ]
    .join("\n")
    .slice(0, 4000);
}

async function attempt(url: string, chatId: string, text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    // Deliberately drop the original error: its message can contain the request URL (and token).
    throw new TelegramError("network");
  }

  let payload: { ok?: boolean; error_code?: number; description?: string } | null = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  // HTTP 200 alone is not enough; Telegram reports failures in the body too.
  if (!res.ok || !payload || payload.ok !== true) {
    if (!payload) throw new TelegramError("bad_response", { status: res.status });
    throw new TelegramError("rejected", {
      status: res.status,
      telegramCode: payload.error_code,
      description: payload.description,
    });
  }
}

/** Send the lead. Retries once on transient failures (network, 5xx, 429). */
export async function sendTelegramLead(lead: LeadMessage): Promise<void> {
  const cfg = telegramConfig();
  if (!cfg) throw new TelegramError("not_configured");

  const url = `${cfg.apiBase}/bot${cfg.token}/sendMessage`;
  const text = buildLeadText(lead);

  try {
    await attempt(url, cfg.chatId, text);
  } catch (error) {
    const transient =
      error instanceof TelegramError &&
      (error.kind === "network" || (error.status !== undefined && (error.status >= 500 || error.status === 429)));
    if (!transient) throw error;
    await new Promise((r) => setTimeout(r, 600));
    await attempt(url, cfg.chatId, text);
  }
}
