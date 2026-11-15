import "server-only";
import { createHmac } from "node:crypto";

/**
 * Signed staff identity for the FastAPI bridge (CRM_STAFF_ASSERTION_V1). The Platform has authenticated the staff member
 * itself; this proves to FastAPI which AdminUser the request is for. The signature uses CRM_STAFF_ASSERTION_SECRET, which
 * is separate from the service token and never leaves the server.
 *
 * Format: v1.<base64url(payload)>.<lowercase hex HMAC-SHA256 over the base64url segment>
 */
const ASSERTION_TTL_SECONDS = 60;

export type StaffAssertionPayload = {
  staffId: string;
  email: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
};

export function signStaffAssertion(
  claims: { staffId: string; email: string; requestId: string },
  options: { secret: string; nowSeconds?: number },
): string {
  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: StaffAssertionPayload = {
    staffId: claims.staffId,
    email: claims.email.toLowerCase().trim(),
    requestId: claims.requestId,
    issuedAt,
    expiresAt: issuedAt + ASSERTION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", options.secret).update(encoded, "ascii").digest("hex");
  return `v1.${encoded}.${signature}`;
}
