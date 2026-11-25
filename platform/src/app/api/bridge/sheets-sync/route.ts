import { NextResponse } from "next/server";
import { readBoundedRequestBody, processSignedSheetsWebhook, SheetsWebhookError } from "../../../../server/sheets-webhook.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private-Apps-Script ingress. The route is fail-closed and remains unreachable from the public nginx config until a
 * separately approved exact-path proxy rule is installed. Authentication is HMAC; browser sessions are not accepted.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await readBoundedRequestBody(request);
    const result = await processSignedSheetsWebhook({
      timestamp: request.headers.get("x-bb-timestamp"),
      nonce: request.headers.get("x-bb-nonce"),
      signature: request.headers.get("x-bb-signature"),
      rawBody,
    });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SheetsWebhookError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
