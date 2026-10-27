# Unified booking mapping v1

Status: read-only reconciliation contract. No production cutover is enabled by this document.

## Ownership now and after cutover

| Area | Current owner on boombala main | Target owner after approved cutover | Cutover rule |
| --- | --- | --- | --- |
| Public lead intake | src/app/api/lead/route.ts (telegram-only by default; Platform in dual/strict) | FastAPI birthday lead contract | Keep the current path until the FastAPI adapter is enabled and reconciliation is complete. |
| CRM lead/contact records | Platform PostgreSQL bb.contacts, bb.lead_requests | FastAPI MobileUser, MobileChild, birthday_requests | No phone-only merge; every migrated identity and lead needs an explicit link. |
| Reservation occupancy | Platform bb.slot_reservations | FastAPI birthday_slot_reservations | Exactly one writer. Do not enable the FastAPI writer while Platform booking actions are live. |
| Manual payment facts | No append-only deposit ledger in Platform schema | FastAPI birthday_payment_facts | A manual payment fact never confirms a booking by itself. |
| CRM UI | Existing Next.js Platform admin | Existing Next.js Platform admin calling FastAPI after cutover | No second admin application. |

## Record mapping

| Business object | Platform schema | FastAPI schema | Safe mapping rule | Current blocker |
| --- | --- | --- | --- | --- |
| Parent/contact | bb.contacts.id, name, phone_e164, verification and marketing flags | MobileUser.id, phone and profile fields | Require an approved legacyContactId -> mobileUserId link with evidence. | The schemas are not equivalent; a phone match is only a candidate. |
| Child | lead_requests.children is a count | MobileChild.id and child snapshot on birthday_requests | A count cannot be expanded into child identities. Keep as legacy evidence until the parent explicitly links children. | Historical child identities are absent from the Platform lead. |
| Branch | No branch field in the public lead contract; Platform catalog must be checked | branch_id on request/reservation | Require an explicit catalog map. Never invent a branch for old leads. | Existing public form has no branch selection. |
| Package | bb.packages.id; public IDs include wow-party, magic-party, boom-party, undecided | birthday_package_id and package snapshot | Require an explicit package map and preserve the source ID. undecided needs manager selection before confirmation. | FastAPI catalog IDs and historical aliases must be exported and compared. |
| Room | bb.rooms.id; public room IDs are validated in src/lib/lead.ts | preferred_room_id on a lead; room_id on a reservation | Map only through catalog evidence. A preferred room on a lead is not occupancy. | Historical aliases and branch scope are not yet reconciled. |
| Slot | bb.time_slots.id (smallint); site sends 1, 2, 3 as strings | FastAPI contract uses string slotId | Convert only through the explicit slot map; preserve the original value in the reconciliation export. | String/number and catalog IDs differ between systems. |
| Birthday request | bb.lead_requests.id, status, UTM, consent-linked contact | birthday_requests.id, parent/child, snapshots, preferences and idempotency | Require a lead link and compare date/catalog/status fields. Do not copy by phone or date alone. | Status vocabularies and identity ownership differ. |
| Reservation | bb.slot_reservations.id, active-cell and active-lead unique indexes | birthday_slot_reservations.id, active-cell and active-request unique indexes | Never copy active rows blindly. Reconcile first, then cut over one writer with a rollback plan. | Two independent reservation tables and live writers exist today. |
| Payment | Platform reservation price_kzt is a catalog snapshot; no deposit fact table in 004_crm.sql/006_bookings.sql | birthday_payment_facts is append-only, manager manual facts with idempotency | Import only evidenced facts with source, amount, method, time and actor. No synthetic payment facts. | No Platform source ledger was identified for historical deposits. |
| Consent | bb.legal_documents, bb.consent_events, consent registration tables | FastAPI consent/lead fields and existing mobile legal flows | Preserve document/version, timestamp and method; do not reduce history to a boolean. | Cross-system document IDs and versions require an explicit legal mapping. |

## Status mapping proposal

This is a comparison map, not an automatic migration:

| Platform lead_requests.status | FastAPI candidate | Rule |
| --- | --- | --- |
| new | new | Safe only after an explicit lead link. |
| in_progress | in_progress | Preserve the legacy value until CRM policy approves a newer status. |
| confirmed | booked | Only when the reservation link is active and the final price is evidenced. |
| cancelled | cancelled | Verify the reservation release/history first. |
| completed | completed | Requires operational completion evidence. |

paid is not inferred from a Platform status or from a manager's note. FastAPI birthday_payment_facts remains the source for new manual payment facts after cutover.

## Reconciliation procedure

platform/src/core/unified-reconciliation.ts compares exported snapshots and returns IDs and conflicts only. It does not connect to production and does not mutate either database. The input must contain:

1. Platform lead snapshots and FastAPI request snapshots.
2. Explicit, evidenced contact links.
3. Explicit lead links. An identity link alone is insufficient because one parent can have multiple requests.
4. Explicit branch/package/room/slot/status mappings.

The report treats a phone match as a candidate list only. It never marks a record matched by phone, name, date or package. Unknown catalog mappings, identity mismatch, status mismatch, reservation mismatch and payment mismatch remain conflicts for manual resolution.

## Adapter and cutover guard

The existing src/app/api/lead/route.ts continues to use its current pipeline. The current boombala main branch has no enabled FastAPI booking mutation adapter. Existing FastAPI client work is in separate branches/PRs (feat/site-fastapi-client-foundation, feat/site-calendar-fastapi-contract, and feat/admin-leads-fastapi-contract) and must be reviewed against this mapping before use.

The next adapter PR must be server-side and require all of the following before any mutation:

- a dedicated UNIFIED_FASTAPI_CRM_ENABLED=false default;
- explicit request/identity/catalog mapping for the record;
- request correlation and idempotency keys;
- FastAPI admin authentication, branch/role authorization and safe error translation;
- a deployment-level cutover confirmation;
- a rollback switch that stops new FastAPI mutations without replaying them to Platform;
- proof that Platform booking actions are disabled before the FastAPI booking writer is enabled.

Until then, the only safe integration work is read-only availability/contract work and export reconciliation. No live dual-write or production data migration is part of this PR.
