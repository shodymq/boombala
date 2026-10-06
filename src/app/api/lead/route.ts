import { PACKAGE_OPTIONS, validateLead } from "@/lib/lead";
import { rateLimit } from "@/lib/rate-limit";
import { sendTelegramLead, telegramConfig, telegramDiagnostics, TelegramError } from "@/lib/telegram";

export const runtime = "nodejs";

const MAX_BODY = 4 * 1024;
const isDev = process.env.NODE_ENV !== "production";
/** Generous in development so repeated manual tests are not blocked. */
const RATE_LIMIT = isDev ? 60 : 5;

/** Safe diagnostics: never includes the token, the Telegram URL or any env value. */
const dev = (...args: unknown[]) => {
  if (isDev) console.info("[lead]", ...args);
};

const json = (body: Record<string, unknown>, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(request: Request) {
  dev("request received");
  try {
    // 403: same-origin only (blocks other sites posting through a visitor's browser).
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        /* handled below */
      }
      if (!originHost || originHost !== host) {
        console.warn(`[lead] rejected: origin mismatch (origin=${originHost || "invalid"} host=${host})`);
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    // 429: rate limit
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const limit = rateLimit(`lead:${ip}`, RATE_LIMIT);
    if (!limit.ok) {
      console.warn("[lead] rejected: rate limited");
      return json({ ok: false, error: "rate_limited" }, 429, { "Retry-After": String(limit.retryAfter) });
    }

    // 400: malformed body
    const raw = await request.text();
    let body: Record<string, unknown>;
    try {
      if (raw.length > MAX_BODY) throw new Error("too large");
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return json({ ok: false, error: "bad_request" }, 400);
    }

    // 403: honeypot. Real people never fill this hidden field.
    if (clip(body.website, 200)) {
      console.warn("[lead] rejected: honeypot filled");
      return json({ ok: false, error: "forbidden" }, 403);
    }

    // 400: invalid form data
    const result = validateLead(body);
    if (!result.ok || !result.data) {
      dev("validation failed:", Object.keys(result.errors).join(","));
      return json({ ok: false, error: "validation", fieldErrors: result.errors }, 400);
    }
    const lead = result.data;
    dev("validation passed");

    // 503: credentials missing
    const diagnostics = telegramDiagnostics();
    if (!telegramConfig()) {
      console.error("[lead] telegram not configured", diagnostics);
      return json({ ok: false, error: "not_configured" }, 503);
    }
    dev("telegram config present", diagnostics);

    // Path only: UTM parameters are reported separately.
    const page = clip(body.page, 200).split(/[?#]/)[0];
    try {
      dev("telegram request started");
      await sendTelegramLead({
        name: lead.name,
        phone: lead.phone,
        date: lead.date,
        children: lead.children,
        packageLabel: PACKAGE_OPTIONS.find((o) => o.value === lead.package)?.label ?? lead.package,
        page: page.startsWith("/") ? page : "",
        referrer: clip(body.referrer, 300),
        utmSource: clip(body.utm_source, 100),
        utmMedium: clip(body.utm_medium, 100),
        utmCampaign: clip(body.utm_campaign, 100),
      });
      dev("telegram response: OK");
      return json({ ok: true });
    } catch (error) {
      // 502: Telegram refused or could not be reached. Log only safe fields.
      if (error instanceof TelegramError) {
        if (error.kind === "not_configured") return json({ ok: false, error: "not_configured" }, 503);
        console.error("[lead] telegram error:", error.label, {
          ...diagnostics,
          telegramStatus: error.status ?? null,
          telegramErrorCode: error.telegramCode ?? null,
          telegramErrorDescription: error.description ?? null,
        });
        return json({ ok: false, error: "delivery_failed" }, 502);
      }
      throw error;
    }
  } catch {
    // 500: anything unexpected. No details to the client, no stack with secrets in logs.
    console.error("[lead] unexpected server error");
    return json({ ok: false, error: "server_error" }, 500);
  }
}
