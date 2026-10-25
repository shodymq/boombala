import type { NextRequest } from "next/server";

/** Same-origin check for credential ceremonies; VPN isolation is still enforced by proxy/firewall. */
export function hasExpectedOrigin(request: NextRequest, expectedOrigin: string): boolean {
  return request.headers.get("origin") === expectedOrigin;
}

export function hasResponseShape(value: unknown): value is { response: Record<string, unknown>; label?: unknown } {
  if (!value || typeof value !== "object") return false;
  const response = (value as { response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.length >= 20 && id.length <= 1024;
}
