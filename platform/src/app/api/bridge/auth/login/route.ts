import { NextRequest } from "next/server";
import { bridgeLogin } from "../../../../../server/legacy-bridge.ts";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return bridgeLogin(request); }
