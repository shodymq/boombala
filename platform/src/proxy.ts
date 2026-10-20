import { NextResponse, type NextRequest } from "next/server";

const https = process.env.PLATFORM_HTTPS === "1";
const SESSION_COOKIE = https ? "__Host-bb_session" : "bb_session";
const dev = process.env.NODE_ENV === "development";

/**
 * 1. Security headers + a per-request CSP nonce on every page.
 * 2. OPTIMISTIC redirect of visitors without a session cookie. This is only a convenience: real authorization
 *    happens on the server in the data access layer (src/server/dal.ts) for every page and action.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Machine endpoints authenticate themselves (Bearer secrets) and must not be redirected to the login page.
  const isPublic = pathname === "/login" || pathname === "/api/health" || pathname.startsWith("/api/intake/") || pathname.startsWith("/api/public/") || pathname.startsWith("/api/cron/");
  if (!isPublic && !request.cookies.get(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.headers.set("Cache-Control", "no-store");
  if (https) response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
