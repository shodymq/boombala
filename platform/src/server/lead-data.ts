import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";
import type { LeadDetail, LeadFilter, LeadPage } from "../core/lead-queue.ts";
import { getLead, searchLeads } from "../core/lead-queue.ts";
import { LEAD_NEXT_ACTIONS, type LeadWorkflowContext } from "../core/lead-workflow.ts";
import type { CatalogItem, TimeSlot } from "../core/catalog.ts";
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
  preferredStartTime: z.string().regex(/^\d{2}:00$/).nullable(),
  roomId: z.string().nullable(),
  packageId: z.string().nullable(),
  children: z.number().nullable(),
  reservationId: z.string().nullable(),
  assignedTo: z.string().uuid().nullable(),
  assigneeName: z.string().nullable(),
  nextAction: z.enum(LEAD_NEXT_ACTIONS).nullable(),
  followUpAt: z.string().datetime().transform((v) => new Date(v)).nullable(),
  workflowVersion: z.number().int().positive(),
  followUpOverdue: z.boolean(),
});
const leadPage = z.object({ items: z.array(leadRow), total: z.number(), page: z.number(), pageSize: z.number() });
const leadDetail = leadRow.extend({
  prepaymentKzt: z.number().nullable(),
  possibleDuplicates: z.array(z.object({
    id: z.string().uuid(), seq: z.number(), status: z.string(), requestedDate: z.string(), preferredStartTime: z.string().regex(/^\d{2}:00$/).nullable(),
  })),
});

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

const catalogItem = z.object({ id: z.string(), name: z.string() }).passthrough();
const requestsIndex = z.object({ result: leadPage, packages: z.array(catalogItem) });
const requestCard = z.object({
  lead: leadDetail,
  catalog: z.object({ packages: z.array(catalogItem), rooms: z.array(catalogItem), slots: z.array(z.object({ id: z.number() }).passthrough()) }),
  workflowContext: z.object({
    assignees: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.enum(["owner", "manager"]) })),
    history: z.array(z.object({
      id: z.number(), at: z.string().datetime().transform((v) => new Date(v)), actorName: z.string().nullable(),
      action: z.enum(["lead.claimed", "lead.workflow_updated"]),
      before: z.object({ assignedTo: z.string().uuid().nullable(), assigneeName: z.string().nullable(), nextAction: z.enum(LEAD_NEXT_ACTIONS).nullable(), followUpAt: z.string().datetime().nullable() }),
      after: z.object({ assignedTo: z.string().uuid().nullable(), assigneeName: z.string().nullable(), nextAction: z.enum(LEAD_NEXT_ACTIONS).nullable(), followUpAt: z.string().datetime().nullable() }),
    })),
  }),
});

/** Bridge mode only: the filtered request page and its package names in ONE round trip (`requests.index`). */
export async function loadRequestsIndex(filter: LeadFilter): Promise<{ result: LeadPage; packages: CatalogItem[] }> {
  return requestsIndex.parse(await bridgeRpc<unknown>("requests.index", filter, await token())) as unknown as { result: LeadPage; packages: CatalogItem[] };
}

/** Bridge mode only: one request and the catalog its card shows, in ONE round trip (`requests.card`). Null when it does not exist. */
export async function loadRequestCard(id: string): Promise<{ lead: LeadDetail; catalog: { packages: CatalogItem[]; rooms: CatalogItem[]; slots: TimeSlot[] }; workflowContext: LeadWorkflowContext } | null> {
  try {
    return requestCard.parse(await bridgeRpc<unknown>("requests.card", { id }, await token())) as unknown as { lead: LeadDetail; catalog: { packages: CatalogItem[]; rooms: CatalogItem[]; slots: TimeSlot[] }; workflowContext: LeadWorkflowContext };
  } catch (error) {
    if (error instanceof LegacyBridgeError && error.status === 404) return null;
    throw error;
  }
}
