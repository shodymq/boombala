import "server-only";
import { headers } from "next/headers";

/**
 * Client address as set by OUR reverse proxy (`X-Real-IP`). The app must not be reachable except through that
 * proxy, otherwise this header could be forged (see docs/platform/OPERATIONS.md).
 */
export async function requestMeta(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return { ip: ip.slice(0, 64), userAgent: h.get("user-agent") };
}
