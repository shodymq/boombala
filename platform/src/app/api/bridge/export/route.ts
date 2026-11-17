import { NextRequest } from "next/server";
import { bridgeContactExport } from "../../../../server/legacy-bridge.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return bridgeContactExport(request);
}
