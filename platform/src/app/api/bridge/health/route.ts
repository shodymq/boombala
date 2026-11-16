import type { NextRequest } from "next/server";
import { bridgeHealth } from "../../../../server/legacy-bridge.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return bridgeHealth(request);
}
