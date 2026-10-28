import { createHash, timingSafeEqual } from "node:crypto";
import type { IntakeSource } from "./intake.ts";

/** Constant-time check of `Authorization: Bearer <secret>` against a secret. A missing or short (< 24) secret denies everything. */
export function bearerOk(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 24) return false;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * The bearer token decides the source of an intake request; the request body cannot change it. Two different secrets are
 * required: one per source. If both are configured and equal, nothing is accepted (fail closed).
 */
export function intakeSourceFromBearer(request: Request, env: Record<string, string | undefined> = process.env): IntakeSource | null {
  const site = env.PLATFORM_INTAKE_TOKEN;
  const mobile = env.PLATFORM_MOBILE_INTAKE_TOKEN;
  if (site && mobile && site === mobile) return null;
  if (bearerOk(request, site)) return "birthday_form";
  if (bearerOk(request, mobile)) return "mobile_app";
  return null;
}
