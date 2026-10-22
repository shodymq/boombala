import "server-only";
import { headers } from "next/headers";

/**
 * Client address, from the one header that this deployment's own front door writes:
 *  - on Vercel: `x-vercel-forwarded-for` / `x-forwarded-for`, written by Vercel itself, so a visitor cannot forge them;
 *  - self-hosted (Kazakhstan): ONLY `x-real-ip`, which nginx overwrites with the real peer address (the app listens on
 *    loopback, so nothing else can reach it). A visitor-supplied `x-vercel-*` or `x-forwarded-for` is never believed there.
 */
export async function requestMeta(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  const onVercel = process.env.VERCEL === "1";
  const ip = (onVercel ? h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? h.get("x-real-ip") ?? (onVercel ? h.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? "unknown";
  return { ip: ip.slice(0, 64), userAgent: h.get("user-agent") };
}
