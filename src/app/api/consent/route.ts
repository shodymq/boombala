import { normalizePhone, NAME_MAX } from "@/lib/lead";
import { PlatformError, sendConsentToPlatform } from "@/lib/platform";
import { siteMustRefuse } from "@/lib/site-profile";
import { rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";

export const runtime = "nodejs";

const json = (body: Record<string, unknown>, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** QR registration. No Telegram, no OTP: the contact and the consent history go to the CRM only. Off unless CONSENT_FORM_ENABLED=1. */
export async function POST(request: Request) {
  if (siteMustRefuse("consent")) return json({ ok: false, error: "unavailable" }, 503);
  try {
    if (process.env.CONSENT_FORM_ENABLED !== "1") return json({ ok: false, error: "unavailable" }, 503);

    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        /* handled below */
      }
      if (!originHost || originHost !== host) return json({ ok: false, error: "forbidden" }, 403);
    }

    const raw = await request.text();
    let body: Record<string, unknown>;
    try {
      if (raw.length > 2048) throw new Error("too large");
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    if (clip(body.website, 200)) return json({ ok: false, error: "forbidden" }, 403); // honeypot

    const name = clip(body.name, 200).replace(/\s+/g, " ");
    // The phone is optional in the QR form: empty means "no phone", a filled value must be a valid number.
    const rawPhone = clip(body.phone, 40);
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    const fieldErrors: Record<string, string> = {};
    if (name.length < 2) fieldErrors.name = "Укажите имя";
    else if (name.length > NAME_MAX) fieldErrors.name = "Слишком длинное имя";
    if (rawPhone && !phone) fieldErrors.phone = "Проверьте номер телефона";
    if (body.acceptRules !== true) fieldErrors.acceptRules = "Подтвердите, что ознакомились с правилами";
    if (body.acceptPersonalData !== true) fieldErrors.acceptPersonalData = "Необходимо согласие на обработку данных";
    if (Object.keys(fieldErrors).length) return json({ ok: false, error: "validation", fieldErrors }, 400);

    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const limitKey = `consent:${ip}`;
    const check = rateLimitCheck(limitKey, 30);
    if (!check.ok) return json({ ok: false, error: "rate_limited" }, 429, { "Retry-After": String(check.retryAfter) });

    try {
      const { duplicate } = await sendConsentToPlatform({
        idempotencyKey: UUID.test(clip(body.idempotencyKey, 40)) ? clip(body.idempotencyKey, 40) : crypto.randomUUID(),
        name,
        phone,
        acceptRules: true,
        acceptPersonalData: true,
        clientIp: ip,
        userAgent: request.headers.get("user-agent") ?? "",
      });
      if (!duplicate) rateLimitRecord(limitKey);
      return json({ ok: true });
    } catch (error) {
      console.warn(`[consent] platform path failed (${error instanceof PlatformError ? error.kind : "unavailable"})`);
      return json({ ok: false, error: "unavailable" }, 503);
    }
  } catch {
    console.error("[consent] unexpected server error");
    return json({ ok: false, error: "server_error" }, 500);
  }
}
