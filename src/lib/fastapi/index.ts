import "server-only";
import { createFastapiClient, parseFastapiConfig, type FastapiClient, type FastapiLogLine } from "./core";

export * from "./core";

/**
 * Server-only entry point. Reads FASTAPI_* from the environment and never exposes the base URL or any
 * token to the browser. Logs only the redacted call summary (route template, status, outcome, timing).
 */
function logLine(line: FastapiLogLine) {
  if (process.env.NODE_ENV === "production" && line.outcome === "ok") return;
  console.info(JSON.stringify(line));
}

let cached: FastapiClient | undefined;

/** Returns a client. Throws FastapiError("not_configured") only when a feature is on and the URL is unsafe. */
export function fastapiClient(): FastapiClient {
  if (cached) return cached;
  cached = createFastapiClient({ config: parseFastapiConfig(process.env), logger: logLine });
  return cached;
}
