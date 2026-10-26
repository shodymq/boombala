/**
 * Adapter: FastAPI public availability → the response the existing AvailabilityPanel already reads.
 *
 * Rules (all fail-closed):
 *  - a cell is FREE only when FastAPI says "free" for that exact date, room and slot;
 *  - a missing cell, a duplicate cell, an unknown status or a slot without a time range is an error, never "free";
 *  - the answer must belong to the requested branch, date or month (branch / period mismatch is an error);
 *  - a price is shown only when FastAPI gives one (priceSource "catalog_base"); otherwise it is null = unknown;
 *    no tariff is invented;
 *  - the output is built field by field: customer data or any other extra field cannot pass through.
 *
 * The site's ids and FastAPI's ids differ (site "1" ↔ FastAPI "slot-morning"). The mapping is an explicit catalog
 * map from configuration; it is complete and one-to-one or the calendar is unavailable.
 */
import { isSafeBranchId, type PublicAvailabilityResponse } from "../fastapi/core.ts";

export type AdapterFailure = "catalog_map_invalid" | "branch_mismatch" | "period_mismatch" | "incomplete" | "malformed";

export class AvailabilityAdapterError extends Error {
  readonly kind: AdapterFailure;

  constructor(kind: AdapterFailure) {
    super(`availability:${kind}`);
    this.name = "AvailabilityAdapterError";
    this.kind = kind;
  }
}

/** The ids the site renders. Passed in by the caller so that this module does not import images or UI data. */
export interface SiteVocabulary {
  roomIds: readonly string[];
  /** Site slot ids are numeric strings ("1", "2", "3"); the panel compares them as strings. */
  slotIds: readonly string[];
  /** Real packages only (no "undecided"). */
  packageValues: readonly string[];
}

export interface CatalogMap {
  branchId: string;
  /** site room id → FastAPI room id */
  rooms: Record<string, string>;
  /** site slot id → FastAPI slot id */
  slots: Record<string, string>;
  /** site package value → FastAPI package id */
  packages: Record<string, string>;
}

/** The same shapes AvailabilityPanel reads (Day / Month), built here from scratch. */
export interface PanelDay {
  date: string;
  slots: Array<{ id: number; startsAt: string; endsAt: string; freeRoomIds: string[] }>;
  prices: Record<string, { amountKzt: number; source: "base" } | null>;
}

export interface PanelMonth {
  month: string;
  roomCount: number;
  days: Record<string, Record<string, number>>;
}

const fail = (kind: AdapterFailure): never => {
  throw new AvailabilityAdapterError(kind);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses and checks the catalog map. Throws catalog_map_invalid for anything incomplete, ambiguous or unsafe. */
export function parseCatalogMap(raw: string | undefined, vocab: SiteVocabulary): CatalogMap {
  if (!raw || !raw.trim()) return fail("catalog_map_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("catalog_map_invalid");
  }
  if (!isRecord(parsed) || typeof parsed.branchId !== "string" || !isSafeBranchId(parsed.branchId)) return fail("catalog_map_invalid");

  const section = (key: "rooms" | "slots" | "packages", siteIds: readonly string[]): Record<string, string> => {
    const value = parsed[key];
    if (!isRecord(value) || siteIds.length === 0) return fail("catalog_map_invalid");
    const out: Record<string, string> = {};
    const seenBackend = new Set<string>();
    for (const siteId of siteIds) {
      const backendId = value[siteId];
      if (typeof backendId !== "string" || !isSafeBranchId(backendId)) return fail("catalog_map_invalid"); // missing = incomplete
      if (seenBackend.has(backendId)) return fail("catalog_map_invalid"); // two site ids must not share one backend id
      seenBackend.add(backendId);
      out[siteId] = backendId;
    }
    if (Object.keys(value).length !== siteIds.length) return fail("catalog_map_invalid"); // extra entries are not allowed
    return out;
  };

  if (vocab.slotIds.some((id) => !/^\d+$/.test(id))) return fail("catalog_map_invalid");
  return {
    branchId: parsed.branchId,
    rooms: section("rooms", vocab.roomIds),
    slots: section("slots", vocab.slotIds),
    packages: section("packages", vocab.packageValues),
  };
}

/** Index of FastAPI cells for one date range. A duplicate cell means the answer cannot be trusted. */
function cellIndex(raw: PublicAvailabilityResponse): Map<string, "free" | "busy"> {
  const index = new Map<string, "free" | "busy">();
  for (const c of raw.availability) {
    const key = `${c.date}|${c.roomId}|${c.slotId}`;
    if (index.has(key)) fail("malformed");
    index.set(key, c.status);
  }
  return index;
}

function checkIdentity(raw: PublicAvailabilityResponse, branchId: string, map: CatalogMap) {
  if (map.branchId !== branchId) fail("branch_mismatch");
  if (raw.branchId !== branchId) fail("branch_mismatch");
}

function priceFor(raw: PublicAvailabilityResponse, backendPackageId: string | undefined): { amountKzt: number; source: "base" } | null {
  if (!backendPackageId) return null; // the site package is not mapped → its price is unknown
  const pkg = raw.packages.find((p) => p.id === backendPackageId);
  if (!pkg || pkg.priceKzt === null) return null; // not offered or no price → unknown, never a made-up tariff
  if (pkg.priceSource !== "catalog_base") fail("malformed"); // an unknown price origin is not shown
  return { amountKzt: pkg.priceKzt, source: "base" };
}

/** One day: which site rooms are free in each site slot, and the price of each site package. */
export function adaptDay(raw: PublicAvailabilityResponse, req: { branchId: string; date: string }, map: CatalogMap, vocab: SiteVocabulary): PanelDay {
  checkIdentity(raw, req.branchId, map);
  if (raw.date !== req.date || raw.month !== null) fail("period_mismatch");
  const cells = cellIndex(raw);

  const slots = vocab.slotIds.map((siteSlot) => {
    const backendSlot = map.slots[siteSlot];
    const info = raw.slots.find((s) => s.id === backendSlot);
    if (!info) throw new AvailabilityAdapterError("incomplete");
    const freeRoomIds = vocab.roomIds.filter((siteRoom) => {
      const status = cells.get(`${req.date}|${map.rooms[siteRoom]}|${backendSlot}`);
      if (status === undefined) fail("incomplete"); // no cell → we cannot say it is free
      return status === "free";
    });
    return { id: Number(siteSlot), startsAt: info.startsAt, endsAt: info.endsAt, freeRoomIds };
  });

  const prices: PanelDay["prices"] = {};
  for (const pkg of vocab.packageValues) prices[pkg] = priceFor(raw, map.packages[pkg]);
  return { date: req.date, slots, prices };
}

function daysInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** One month: for every date, the number of free rooms per site slot. Every date and cell must be present. */
export function adaptMonth(raw: PublicAvailabilityResponse, req: { branchId: string; month: string }, map: CatalogMap, vocab: SiteVocabulary): PanelMonth {
  checkIdentity(raw, req.branchId, map);
  if (raw.month !== req.month || raw.date !== null) fail("period_mismatch");
  const cells = cellIndex(raw);
  for (const c of raw.availability) if (!c.date.startsWith(`${req.month}-`)) fail("period_mismatch");

  const days: PanelMonth["days"] = {};
  for (const date of daysInMonth(req.month)) {
    const perSlot: Record<string, number> = {};
    for (const siteSlot of vocab.slotIds) {
      const backendSlot = map.slots[siteSlot];
      if (!raw.slots.some((s) => s.id === backendSlot)) fail("incomplete");
      let free = 0;
      for (const siteRoom of vocab.roomIds) {
        const status = cells.get(`${date}|${map.rooms[siteRoom]}|${backendSlot}`);
        if (status === undefined) fail("incomplete");
        if (status === "free") free += 1;
      }
      perSlot[siteSlot] = free;
    }
    days[date] = perSlot;
  }
  return { month: req.month, roomCount: vocab.roomIds.length, days };
}
