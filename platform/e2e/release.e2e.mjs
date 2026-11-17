// Release E2E entry point for the current FastAPI-backed CRM flow.
// The former script exercised the retired Platform-SQL direct-confirm flow. Keep
// the release command as one deterministic entry point, but delegate the actual
// checks to the current browser/server suites so payment, 409, idempotency,
// signed staff access and logout are tested against the same Server Actions.
// Synthetic staging only; no production URL or credentials are accepted by the
// delegated suites.
import { spawnSync } from "node:child_process";

const required = [
  "PLATFORM_URL",
  "E2E_PASSWORD",
  "PLATFORM_DATABASE_URL",
  "FASTAPI_DATABASE_URL",
  "E2E_CRM_SERVICE_TOKEN",
  "E2E_CRM_STAFF_ASSERTION_SECRET",
  "E2E_FASTAPI_BASE_URL",
  "E2E_ARTIFACTS",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`release E2E environment is incomplete: ${missing.join(", ")}`);

const suites = [
  ["crm-calendar", ["e2e/crm-calendar.e2e.mjs"]],
  ["crm-race", ["--conditions=react-server", "e2e/crm-race.e2e.mjs"]],
  ["crm-security", ["e2e/crm-actions-security.e2e.mjs"]],
  ["crm-lost-response", ["e2e/crm-lost-response.e2e.mjs"]],
];

for (const [name, args] of suites) {
  console.log(`\n## ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nRelease CRM E2E suites passed.");
