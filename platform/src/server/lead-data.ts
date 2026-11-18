import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";
import type { LeadDetail, LeadFilter, LeadPage } from "../core/lead-queue.ts";
import { getLead, searchLeads } from "../core/lead-queue.ts";
import type { Actor } from "../core/rbac.ts";
import { bridgeRpc, legacyBridgeEnabled, LegacyBridgeError } from "./bridge-client.ts";
import { getPool } from "./db.ts";
import { SESSION_COOKIE } from "./env.ts";

/**
 * Request queue data for the pages. In bridge mode it goes over the typed `requests.search` / `requests.get` operations and
 * the answer is validated before use; otherwise it reads the database through the same core functions. Search, filtering and
 * pagination always run in PostgreSQL, never on a truncated list.
 */
const leadRow = z.object({
  id: z.string(),
  seq: z.number(),
  createdAt: z.string().transform((v) => new Date(v)),
  status: z.string(),
  name: z.string(),
  phone: z.string(),
  requestedDate: z.string(),
  slotId: z.number().nullable(),
  roomId: z.string().nullable(),
  packageId: z.string().nullable(),
  children: z.number().nullable(),
  reservationId: z.string().nullable(),
});
const leadPage = z.object({ items: z.array(leadRow), total: z.number(), page: z.number(), pageSize: z.number() });
const leadDetail = leadRow.extend({ prepaymentKzt: z.number().nullable() });

async function token(): Promise<string> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) throw new Error("session_missing");
  return value;
}

export async function loadLeadPage(actor: Actor, filter: LeadFilter): Promise<LeadPage> {
  if (legacyBridgeEnabled()) return leadPage.parse(await bridgeRpc<unknown>("requests.search", filter, await token()));
  return searchLeads(getPool(), actor, filter);
}

/** The concrete request, or null when it does not exist (a 404 from the bridge is "not found", anything else is an error). */
export async function loadLead(actor: Actor, id: string): Promise<LeadDetail | null> {
  if (legacyBridgeEnabled()) {
    try {
      return leadDetail.parse(await bridgeRpc<unknown>("requests.get", { id }, await token()));
    } catch (error) {
      if (error instanceof LegacyBridgeError && error.status === 404) return null;
      throw error;
    }
  }
  return getLead(getPool(), actor, id);
}
