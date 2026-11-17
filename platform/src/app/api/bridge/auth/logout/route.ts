import { NextRequest } from "next/server";
import { bridgeLogout } from "../../../../../server/legacy-bridge.ts";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return bridgeLogout(request); }
