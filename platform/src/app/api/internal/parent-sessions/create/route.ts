import { handleParentSessionAction } from "../../../../../server/parent-sessions.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-to-server only: the public site's BFF. See server/parent-sessions.ts. */
export async function POST(request: Request) {
  return handleParentSessionAction(request, "create");
}
