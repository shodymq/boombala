import { createHmac } from "node:crypto";
import { cleanName, nameKey, normalizePhone } from "../phone.ts";
import type { RawRow } from "./types.ts";

export type StableSourceIdentity = { sourceKey: string; kind: "explicit" | "natural" } | { sourceKey: null; kind: "unusable"; reason: "stable_id_missing" };

/** A keyed digest keeps source identifiers and contact details out of metadata indexes and logs. */
export function stableSourceIdentity(raw: RawRow, hmacKey: string): StableSourceIdentity {
  if (Buffer.byteLength(hmacKey, "utf8") < 32) throw new Error("sheets_sync_key_invalid");
  const supplied = (raw.sourceId ?? "").normalize("NFKC").trim();
  if (supplied) return { sourceKey: digest(hmacKey, `explicit\0${supplied}`), kind: "explicit" };

  // Until managers populate the optional source-id column, a party identity is stable across row moves and event edits.
  // Incomplete or duplicate identities are held for manual review; row number is never an identity input.
  const phone = normalizePhone(raw.phone ?? "");
  const client = nameKey(cleanName(raw.client ?? ""));
  const child = nameKey(cleanName(raw.child ?? ""));
  if (!phone || !client || !child) return { sourceKey: null, kind: "unusable", reason: "stable_id_missing" };
  return { sourceKey: digest(hmacKey, `natural\0${phone}\0${client}\0${child}`), kind: "natural" };
}

/** A content-keyed locator for rows that lack enough fields for a business identity. It is review-only. */
export function reviewSourceIdentity(raw: RawRow, hmacKey: string): string {
  if (Buffer.byteLength(hmacKey, "utf8") < 32) throw new Error("sheets_sync_key_invalid");
  const canonical = Object.fromEntries(Object.entries(raw)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, (value ?? "").normalize("NFKC").trim()]));
  return digest(hmacKey, `manual-review\0${JSON.stringify(canonical)}`);
}

export function sheetRowFingerprint(raw: RawRow, hmacKey: string): string {
  if (Buffer.byteLength(hmacKey, "utf8") < 32) throw new Error("sheets_sync_key_invalid");
  const canonical = Object.fromEntries(Object.entries(raw)
    .filter(([key]) => key !== "sourceId")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, (value ?? "").normalize("NFKC").trim()]));
  return digest(hmacKey, `row-fingerprint\0${JSON.stringify(canonical)}`);
}

/** PII is kept only in the restricted sync row; operational diagnostics contain hashes and safe reason codes only. */
export function sheetPayload(raw: RawRow): RawRow {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "sourceId").map(([key, value]) => [key, (value ?? "").trim()])) as RawRow;
}

function digest(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
