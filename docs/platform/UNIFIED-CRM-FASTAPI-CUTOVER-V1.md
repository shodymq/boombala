# Unified CRM → FastAPI cutover contract v1

**Status:** server-only transport client and safety gate. The client lives in
`platform/src/server/fastapi-crm.ts`, but the writer remains disabled. This
document does not enable a writer, change the Platform database, or migrate
production data.

## Ownership boundary

The existing Next.js Platform CRM remains the employee interface. FastAPI is
the future writer for new unified leads, manual payment facts and confirmed
birthday reservations. Until an approved cutover, the Platform booking writer
remains the only production writer and FastAPI CRM mutations must remain off.

The adapter flag is:

```text
UNIFIED_FASTAPI_CRM_ENABLED=false
```

The safe default is absence or any value other than the explicit approved
enable value. This flag must be evaluated server-side in the Next.js CRM; it
must never be a browser or Flutter flag. When it is off, the existing Platform
actions retain their current behavior. When it is on, the selected mutation
must go only to FastAPI and must never fall through to the Platform writer.

## FastAPI endpoints currently implemented

All paths are relative to `/api/v1` and require a FastAPI admin bearer session.
The Next.js CRM must call these routes server-to-server through a protected
BFF/service boundary; an admin access token or service credential must never be
placed in browser JavaScript or a public response.

| CRM operation | Method and path | Required business input | Result |
| --- | --- | --- | --- |
| Lead inbox | `GET /admin/leads` | optional `branchId`, status/date filters | branch-scoped lead list |
| Lead detail | `GET /admin/leads/{leadId}/birthday` | explicit FastAPI lead ID | birthday lead and current payment/status facts |
| Lead status | `PATCH /admin/leads/{leadId}/status` | status plus allowed note/amount fields | updated lead; status authorization applies |
| Manual payment fact | `POST /admin/birthday-requests/{requestId}/manual-payments` | amount, method, receivedAt, idempotencyKey | immutable `manager_manual` fact |
| Confirm booking | `POST /admin/birthday-bookings/confirm` | request, date, room, slot, package, agreed final price, idempotencyKey | atomic confirmed reservation |
| Manual block | `POST /admin/birthday-slots/block` | branch, date, room, slot, reason, idempotencyKey | atomic blocked reservation |
| Release | `POST /admin/birthday-reservations/{reservationId}/release` | reason and idempotencyKey | released reservation and audit |

The exact request and response schemas are authoritative in
`BoomBalaApp/backend/app/modules/admin_leads/schemas.py` and
`BoomBalaApp/backend/app/modules/birthday_bookings/{schemas.py,payment_schemas.py}`.
The CRM adapter must not reconstruct or weaken those validations.

## Authorization and branch scope

FastAPI derives access from the authenticated admin session. Lead-inbox roles
are `super_admin`, `operator` and `sales_manager`; an `operator` is restricted
to its assigned active branch, while global roles may select a branch. The CRM
must forward the acting staff identity and preserve the FastAPI audit actor;
it must not substitute a shared owner identity.

Before enabling mutations, the owner must approve the server-to-server auth
mechanism, secret storage and rotation procedure. A Next.js browser session is
not evidence that a request is authorized to FastAPI.

The current adapter accepts only a short-lived FastAPI admin access token for
the same acting staff member. It deliberately has no shared owner token or
environment-wide fallback. Until a per-staff session bridge is approved and
implemented, enabling `UNIFIED_FASTAPI_CRM_ENABLED=1` without an actor token
fails closed and the legacy writer must not be called by the same action.

## Manager workflow and invariants

1. CRM loads the FastAPI lead using an explicit linked lead ID.
2. Manager may record a manual payment fact. This is evidence of money
   received by staff, not an online provider callback and not a booking.
3. Manager supplies an agreed final price. A catalog `price_from` value is not
   accepted as the final price.
4. Manager selects a catalog-mapped branch, room and slot.
5. CRM sends one confirmation command with a stable idempotency key.
6. FastAPI atomically claims the slot under PostgreSQL constraints.
7. A repeated command returns the original result; a different command under
   the same key is rejected. A competing slot claim returns `409`.
8. A pending lead or a preferred room/slot on a lead never occupies a slot.
9. Release is an explicit command and preserves audit/history.

The adapter must not infer `paid` from a note, from a manual payment fact, or
from an old Platform status. It must not change a lead to `booked` before the
FastAPI confirmation response is committed.

## Mapping required before runtime implementation

No IDs are invented by this contract. The following signed-off maps are
required before `UNIFIED_FASTAPI_CRM_ENABLED` can be enabled:

- Platform contact/lead ID → FastAPI lead ID, with evidence; phone-only
  matches remain candidates and are not links.
- Platform branch → FastAPI branch.
- Platform package aliases (`wow-party`, `magic-party`, `boom-party`,
  `undecided`) → FastAPI package IDs.
- Platform room aliases (`roblox-room`, `ice-room`, `magic-room`,
  `rapunzel-room`) → FastAPI room IDs, including branch scope.
- Platform slot values (`1`, `2`, `3`) → FastAPI slot IDs.
- Legacy status → FastAPI status, with reservation evidence for any booked
  mapping.
- Approved consent document kind/version → FastAPI provenance fields.

Unknown or ambiguous values stay blocked for manual review. A legacy children
count does not create `MobileChild` rows. A Platform reservation price or
manager note does not create a historical `BirthdayPaymentFact`.

## No-dual-write cutover

The cutover is a controlled sequence, not a runtime fallback:

1. Export both systems read-only and produce a reconciliation report.
2. Resolve every active reservation, catalog mapping and identity conflict.
3. Demonstrate the complete flow against an isolated PostgreSQL staging DB.
4. Freeze or disable the matching Platform booking mutations at the same
   release boundary that enables the FastAPI CRM writer.
5. Enable the CRM flag only after the old writer is proven inactive and the
   backup/restore point is recorded.
6. Canary one staff role/branch and compare lead, payment, reservation and
   audit reads.
7. Roll back by disabling the FastAPI flag and restoring the previous code
   path. Do not replay failed FastAPI commands to Platform automatically.

If the boundary cannot guarantee one writer, the cutover is blocked.

## Acceptance evidence for the next runtime PR

- isolated PostgreSQL 16 upgrade plus restore drill;
- one website lead visible in the existing CRM through the approved link;
- one manager manual payment fact with actor, method, amount and timestamp;
- one agreed-price confirmation and one occupied slot;
- ten or more concurrent confirmations yield exactly one reservation;
- repeated payment/booking commands are idempotent;
- release makes the slot available again without deleting history;
- another family cannot read the booking;
- FastAPI error cannot produce a success state in the CRM;
- both online payment creation and booking remain fail-closed by default;
- no production data, DNS, service, or database is changed by the test.

Until these conditions and the external catalog/auth approvals exist, the
CRM runtime cutover remains blocked. The existing Next.js CRM is not replaced,
no second admin application is created, and no dual-write fallback is allowed.
