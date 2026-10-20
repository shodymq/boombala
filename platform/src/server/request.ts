import "server-only";
import { headers } from "next/headers";

/**
 * Client address as set by the platform in front of the app. On Vercel `x-vercel-forwarded-for` / `x-forwarded-for` are
 * written by Vercel itself, so a visitor cannot forge them. If the app is ever run behind another proxy, that proxy
 * must overwrite these headers (and the app must not be reachable except through it).
 */
export async function requestMeta(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  const ip = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return { ip: ip.slice(0, 64), userAgent: h.get("user-agent") };
}
