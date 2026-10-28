// Server-side harness for the CRM calendar E2E: talks to the local FastAPI staging with the same signed staff bridge the
// Platform uses. Test-only; secrets come from the environment and are never printed.
import { createHmac, randomUUID } from "node:crypto";

const base = () => process.env.E2E_FASTAPI_BASE_URL ?? "http://127.0.0.1:8000";

export function signAssertion({ staffId, email, requestId, secret }) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ staffId, email, requestId, issuedAt: now, expiresAt: now + 60 }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded, "ascii").digest("hex");
  return `v1.${encoded}.${signature}`;
}

/** A FastAPI staff token for a linked AdminUser, obtained exactly like the Platform does. */
export async function staffToken({ email, staffId }) {
  const requestId = randomUUID();
  const response = await fetch(`${base()}/api/v1/admin/auth/service/staff-access-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-crm-service-token": process.env.E2E_CRM_SERVICE_TOKEN,
      "x-crm-staff-assertion": signAssertion({ staffId, email, requestId, secret: process.env.E2E_CRM_STAFF_ASSERTION_SECRET }),
      "x-request-id": requestId,
    },
    body: JSON.stringify({ email, requestId }),
  });
  if (!response.ok) throw new Error(`bridge refused ${response.status}`);
  return (await response.json()).access_token;
}

export async function api(token, method, path, body) {
  const response = await fetch(`${base()}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Creates a request and records a manual prepayment, without confirming. Returns the request id. */
/** A phone no earlier run used: the duplicate rule keys on phone, so a fixed test phone would find old requests. */
export function uniquePhone() {
  return `+7700${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`;
}

export async function paidUnconfirmedRequest(token, { branchId, packageId, amountKzt, customerName, phone = uniquePhone(), requestedDate }) {
  const key = randomUUID();
  const created = await api(token, "POST", "/admin/birthday-requests", {
    branchId, packageId, customerName, phone, guestCount: 10, requestedDate, idempotencyKey: `${key}:req`,
  });
  if (created.status !== 201) throw new Error(`request ${created.status}`);
  const payment = await api(token, "POST", `/admin/birthday-requests/${created.body.id}/manual-payments`, {
    amountKzt, method: "cash", idempotencyKey: `${key}:pay`,
  });
  if (payment.status !== 200) throw new Error(`payment ${payment.status}`);
  return created.body.id;
}

export const lead = (token, id) => api(token, "GET", `/admin/leads/${id}/birthday`);
