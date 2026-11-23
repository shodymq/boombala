import "server-only";

import { randomUUID } from "node:crypto";

export type BridgeLoginInput = { email: string; password: string; ip?: string | null; userAgent?: string | null; mfaRequired: boolean; rememberDevice: boolean };
export type BridgeLoginResult =
  | { ok: true; token: string; expiresAt: string; userId: string; mfa: "none" | "verify" | "enroll" }
  | { ok: false; reason: "invalid" | "locked"; retryAfterSeconds?: number };

export type BridgeSession = {
  sessionId: string;
  rememberDevice: boolean;
  user: { id: string; email: string; name: string; role: "owner" | "manager" | "editor"; canExport: boolean };
};

export class LegacyBridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, code: string, requestId: string) {
    super(code);
    this.name = "LegacyBridgeError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function legacyBridgeEnabled(): boolean {
  return process.env.CRM_BRIDGE_MODE === "legacy";
}

function bridgeBase(): string {
  const raw = (process.env.CRM_BRIDGE_URL ?? process.env.FASTAPI_ADMIN_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new LegacyBridgeError(503, "bridge_url_missing", "config");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LegacyBridgeError(503, "bridge_url_invalid", "config");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new LegacyBridgeError(503, "bridge_url_invalid", "config");
  }
  return url.toString().replace(/\/+$/, "");
}

function serviceToken(): string {
  const token = (process.env.CRM_SERVICE_TOKEN ?? "").trim();
  if (token.length < 32) throw new LegacyBridgeError(503, "bridge_token_missing", "config");
  return token;
}

async function send(path: string, init: RequestInit = {}, sessionToken?: string, timeoutMs = 8000, accept = "application/json"): Promise<Response> {
  const requestId = randomUUID();
  const headers = new Headers(init.headers);
  headers.set("Accept", accept);
  headers.set("X-CRM-Service-Token", serviceToken());
  headers.set("X-Request-ID", requestId);
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  // Let fetch set the multipart boundary for image uploads. JSON bodies use the
  // bridge's ordinary content type; never overwrite a caller's explicit type.
  if (init.body !== undefined && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const startedAt = performance.now();
  const response = await fetch(`${bridgeBase()}${path}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (process.env.CRM_PERF_LOG === "1") {
    // Durations only (round trip as seen from the frontend, and the bridge's own Server-Timing). No bodies, no tokens.
    console.info(`[bridge-client] ${init.method ?? "GET"} ${path} op=${headers.get("x-crm-op") ?? "-"} status=${response.status} rtt=${(performance.now() - startedAt).toFixed(1)}ms server="${response.headers.get("server-timing") ?? ""}"`);
  }
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const code = body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "bridge_error";
    throw new LegacyBridgeError(response.status, code, requestId);
  }
  return response;
}

async function call<T>(path: string, init: RequestInit = {}, sessionToken?: string): Promise<T> {
  const response = await send(path, init, sessionToken);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return body as T;
}

export function bridgeLogin(input: BridgeLoginInput): Promise<BridgeLoginResult> {
  return call<BridgeLoginResult>("/api/bridge/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function bridgeMfa(input: { pendingToken?: string; code: string; ip?: string | null; userAgent?: string | null }): Promise<{ ok: true; token: string; expiresAt: string; userId: string; recoveryCodes?: string[] } | { ok: false; reason: "invalid" | "expired" | "locked"; retryAfterSeconds?: number }> {
  return call("/api/bridge/auth/mfa", { method: "POST", body: JSON.stringify(input) });
}

export function bridgeSession(token: string | undefined, state: "verified" | "pending" = "verified"): Promise<BridgeSession | null> {
  if (!token) return Promise.resolve(null);
  return call<{ session: BridgeSession | null }>(`/api/bridge/auth/session?state=${state}`, {}, token).then((x) => x.session);
}

export function bridgeEnrollment(token: string): Promise<{ enrolled: boolean; secret?: string; otpauth?: string }> {
  return call("/api/bridge/auth/enrollment", { method: "POST" }, token);
}

export function bridgeLogout(token: string | undefined): Promise<void> {
  if (!token) return Promise.resolve();
  return call("/api/bridge/auth/logout", { method: "POST" }, token).then(() => undefined);
}

export function bridgeRpc<T>(op: string, input: unknown, sessionToken: string): Promise<T> {
  return call<T>("/api/bridge/rpc", { method: "POST", body: JSON.stringify({ op, input }), headers: { "X-CRM-Op": op } }, sessionToken);
}

export type BridgeExportInput = {
  format: "csv" | "xlsx";
  columns: string[];
  from?: string;
  to?: string;
  filters?: { q?: string; source?: string; verification?: string };
};

/** Streams an authorized contact export from the VPS; no Vercel database connection is used. */
export function bridgeExport(input: BridgeExportInput, sessionToken: string): Promise<Response> {
  return send("/api/bridge/export", { method: "POST", body: JSON.stringify(input) }, sessionToken, 60_000, "application/octet-stream");
}

/** Uploads an image to the VPS where it is decoded, metadata-stripped and stored. */
export async function bridgeImageUpload(file: File, alt: string, sessionToken: string): Promise<void> {
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("alt", alt);
  await send("/api/bridge/media", { method: "POST", body: form }, sessionToken, 60_000);
}

/** Reads a private staff-only image from the VPS without a Vercel database connection. */
export function bridgeImage(id: string, sessionToken: string): Promise<Response> {
  return send(`/api/bridge/media/${encodeURIComponent(id)}`, {}, sessionToken, 8_000, "image/webp");
}

export function bridgeHealth(): Promise<{ ok: true }> {
  return call<{ ok: true }>("/api/bridge/health");
}
