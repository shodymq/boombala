import { getRoomName } from "@/data/birthdayRooms";
import { PACKAGE_OPTIONS, validateLead } from "@/lib/lead";
import { deliverOnce, rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";
import { sendTelegramLead, telegramConfig, telegramDiagnostics, TelegramError } from "@/lib/telegram";

export const runtime = "nodejs";

const MAX_BODY = 4 * 1024;
const isDev = process.env.NODE_ENV !== "production";
/**
 * Delivered leads per IP per 10 minutes. Deliberately generous: visitors in the same mall share one Wi-Fi
 * (one external IP). This is a best-effort in-memory counter, per serverless instance: it is NOT a reliable
 * distributed limit on Vercel. Real abuse protection belongs in Vercel Firewall / a shared store.
 */
const RATE_LIMIT = 30;

/** Safe diagnostics: never includes the token, the Telegram URL or any env value. */
const dev = (...args: unknown[]) => {
  if (isDev) console.info("[lead]", ...args);
};

const json = (body: Record<string, unknown>, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super("rate_limited");
  }
}

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

    // Client IP as set by the platform (Vercel overwrites x-forwarded-for, so it cannot be spoofed there).
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const limitKey = `lead:${ip}`;

    // 503: credentials missing
    const diagnostics = telegramDiagnostics();
    if (!telegramConfig()) {
      console.error("[lead] telegram not configured", diagnostics);
      return json({ ok: false, error: "not_configured" }, 503);
    }
    dev("telegram config present", diagnostics);

    // Path only: UTM parameters are reported separately.
    const page = clip(body.page, 200).split(/[?#]/)[0];
    const dupKey = `${lead.phone}|${lead.date}|${lead.package}|${lead.room ?? ""}`;
    try {
      // A repeat of a lead that WAS delivered (double tap, quick retry) is acknowledged without a second
      // message. A lead that failed is not remembered, so the parent's retry is sent for real.
      const { duplicate } = await deliverOnce(dupKey, async () => {
        // 429: only genuine deliveries count, so typos, failures and duplicates never lock a parent out.
        const check = rateLimitCheck(limitKey, RATE_LIMIT);
        if (!check.ok) throw new RateLimited(check.retryAfter);
        dev("telegram request started");
        await sendTelegramLead({
          name: lead.name,
          phone: lead.phone,
          date: lead.date,
          children: lead.children,
          packageLabel: PACKAGE_OPTIONS.find((o) => o.value === lead.package)?.label ?? lead.package,
          roomLabel: (lead.room && getRoomName(lead.room)) || "",
          page: page.startsWith("/") ? page : "",
          referrer: clip(body.referrer, 300),
          utmSource: clip(body.utm_source, 100),
          utmMedium: clip(body.utm_medium, 100),
          utmCampaign: clip(body.utm_campaign, 100),
        });
        rateLimitRecord(limitKey);
      });
      dev(duplicate ? "duplicate submission acknowledged" : "telegram response: OK");
      return json(duplicate ? { ok: true, duplicate: true } : { ok: true });
    } catch (error) {
      if (error instanceof RateLimited) {
        console.warn("[lead] rejected: rate limited");
        return json({ ok: false, error: "rate_limited" }, 429, { "Retry-After": String(error.retryAfter) });
      }
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
