import { NextRequest } from "next/server";
import { bridgeSessionResponse } from "../../../../../server/legacy-bridge.ts";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { return bridgeSessionResponse(request); }
