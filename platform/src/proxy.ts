import { NextResponse, type NextRequest } from "next/server";
import { decideExposure, exposureFromEnv, profileProblems } from "./server/exposure.ts";

const https = process.env.PLATFORM_HTTPS === "1";
const SESSION_COOKIE = https ? "__Host-bb_session" : "bb_session";
const dev = process.env.NODE_ENV === "development";

/**
 * 1. Security headers + a per-request CSP nonce on every page.
 * 2. OPTIMISTIC redirect of visitors without a session cookie. This is only a convenience: real authorization
 *    happens on the server in the data access layer (src/server/dal.ts) for every page and action.
 */
const STATIC_ASSET = /^\/(_next\/(static|image)\/|favicon\.ico$)/;
const exposure = exposureFromEnv();
const problems = profileProblems();
if (problems.length) console.error(JSON.stringify({ event: "profile.invalid", problems }));

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Fail closed: a production deployment with a wrong configuration serves nothing.
  if (problems.length) return new NextResponse("Service unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  // What this process may show at all (role, host, source network). Answers carry no body and no hint of what exists.
  const decision = decideExposure(exposure, { pathname, host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"), realIp: request.headers.get("x-real-ip") });
  if (!decision.allow) return new NextResponse(null, { status: decision.status, headers: { "Cache-Control": "no-store" } });
  // CSRF, first line: a state-changing request from another origin is refused here with a plain 403, before any action code
  // runs. Next also checks Origin for Server Actions; this makes the refusal explicit and independent of the framework.
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin !== null) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== host) {
        return new NextResponse("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
    }
  }
  // Build assets carry no data and need no nonce or login redirect, but they follow the same exposure rules (a stranger must not
  // learn that an application lives here by fetching its scripts).
  if (STATIC_ASSET.test(pathname)) return NextResponse.next();
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

/**
 * The matcher is "everything". It must NOT carry a `missing`/`has` condition on a request header such as
 * `next-router-prefetch` (the example in the CSP guide does): a header is chosen by the client, so such a condition
 * lets anyone skip every check in this file (role, Host, VPN network, fail-closed profile) by sending that header.
 * Static assets are let through below, but only AFTER the exposure decision.
 */
export const config = { matcher: "/:path*" };
