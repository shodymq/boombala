import { NextRequest } from "next/server";
import { bridgeImageUpload } from "../../../../server/legacy-bridge.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return bridgeImageUpload(request);
}
