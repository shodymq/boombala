# Unified CRM → FastAPI cutover contract v1

**Status (31 October 2026):** the CRM adapter and local workflows are
implemented in the unpushed `codex/crm-literal-redesign` branch. The flag is
still off. The site and CRM changes have not been deployed, and production data
has not been read or changed. This is implementation status, not cutover
acceptance.

## Ownership boundary

The Next.js Platform remains the employee interface. With the flag off, its
existing database and actions continue to serve the CRM. With the flag on, the
requests and birthday booking pages use FastAPI only; their actions never fall
through to Platform SQL. Other CRM areas (contacts, attendance, news, exports,
documents, retention, staff and audit) still use the current Platform database.
There is no historical data migration in this branch.

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
| Lead inbox | `GET /admin/leads` | optional status/date/search filters | role-scoped lead list |
| Lead detail | `GET /admin/leads/{leadId}` and `/birthday` | explicit FastAPI lead ID | contact or birthday details, individual manual payment/refund facts, and totals |
| Lead status | `PATCH /admin/leads/{leadId}/status` | status and allowed note/amount fields | updated lead with FastAPI authorization |
| Manual payment fact | `POST /admin/birthday-requests/{requestId}/manual-payments` | amount, method, idempotencyKey | immutable `manager_manual` fact |
| Manual refund fact | `POST /admin/birthday-requests/{requestId}/manual-refunds` | actual amount, method, timestamp, reason, idempotencyKey | immutable refund fact and actor audit; no transfer or booking cancellation |
| Confirm booking | `POST /admin/birthday-bookings/confirm` | request, date, room, slot, package, agreed final price, idempotencyKey | atomic confirmed reservation |
| Booking catalog | `GET /admin/birthday-bookings/catalog` | optional branch ID | active branches, rooms, packages and configured buffer |
| Package catalog management | `GET /admin/birthday-packages`, `GET /admin/birthday-packages/{id}`, `POST /admin/birthday-packages`, `PATCH /admin/birthday-packages/{id}` | approved branch and package/price fields | canonical FastAPI catalog; owner-only Next.js editor at `/catalog` |
| Booking timeline | `GET /admin/birthday-bookings/timeline` | one branch and date | role-filtered reservations, occupied end and payment state |
| CRM audit | `GET /admin/birthday-bookings/audit` | owner-only session, optional branch and limit | newest request, booking, manual payment, and refund events without idempotency keys or note text |
| Staff-created request | `POST /admin/birthday-requests` | customer, branch, package, requested date and idempotencyKey | new lead; no slot is held |
| Manual block | `POST /admin/birthday-slots/block` | branch, date, room, start time, reason and idempotencyKey | atomic blocked reservation |
| Reschedule | `POST /admin/birthday-reservations/{reservationId}/reschedule` | new date, room, slot/start time and idempotencyKey | atomic reservation update and audit |
| Release | `POST /admin/birthday-reservations/{reservationId}/release` | reason and idempotencyKey | released reservation and audit; no refund |

The exact request and response schemas are authoritative in
`BoomBalaApp/backend/app/modules/admin_leads/schemas.py` and
`BoomBalaApp/backend/app/modules/birthday_bookings/{schemas.py,payment_schemas.py}`.
The CRM adapter must not reconstruct or weaken those validations.

## Authorization and branch scope

FastAPI derives access from the authenticated admin session. CRM lead and
booking routes allow only `super_admin` (owner) and `sales_manager` (banquet
manager). Other FastAPI roles, including `operator`, are denied. Each linked
staff member must have the matching FastAPI role before the CRM flag is enabled.
The CRM must forward the acting staff identity and preserve the FastAPI audit
actor; it must not substitute a shared owner identity.

Before enabling mutations, the owner must approve the server-to-server auth
mechanism, secret storage and rotation procedure. A Next.js browser session is
not evidence that a request is authorized to FastAPI.

The local adapter obtains a short-lived FastAPI admin token through the
`/admin/auth/service/staff-access-token` bridge. The Platform server signs a
60-second assertion using `CRM_STAFF_ASSERTION_SECRET` and authenticates the
bridge with `CRM_SERVICE_TOKEN`; FastAPI resolves the active employee and
enforces its own role and branch. Missing secrets, unknown/disabled staff or
any API failure stop the command. No owner-wide bearer token or browser token
is used. The mechanism still needs staging review and owner approval before
the CRM flag can be enabled outside a local environment.

## Manager workflow and invariants

1. CRM loads the FastAPI lead using an explicit linked lead ID.
2. Manager may record a manual payment fact. This is evidence of money
   received by staff, not an online provider callback and not a booking.
   A completed refund is recorded separately with its actual time, method,
   reason, actor, and audit. It does not move money or change booking/request
   state. Confirmation is rejected until persisted `manager_manual` payments
   minus recorded refunds total at least 10,000 KZT. Notes and legacy payment
   aggregates do not count.
3. Manager supplies an agreed final price. A catalog `price_from` value is not
   accepted as the final price. The booking stores the agreed amount and
   `manager_agreed` price source; later catalog edits do not rewrite bookings.
4. Manager selects a catalog-mapped branch, room and slot.
5. CRM sends one confirmation command with a stable idempotency key.
6. FastAPI atomically claims the slot under PostgreSQL constraints.
7. A repeated command returns the original result; a different command under
   the same key is rejected. A competing slot claim returns `409`.
8. A pending lead or a preferred room/slot on a lead never occupies a slot.
9. Release is an explicit command and preserves audit/history. A refund is a
   separate business and accounting action; release does not issue one.

The adapter must not infer `paid` from a note, from a manual payment fact, or
from an old Platform status. It must not change a lead to `booked` before the
FastAPI confirmation response is committed.

The lead-status endpoint only updates contact progress, qualification, loss,
and post-event completion. Confirmation alone writes `booked`; reservation
release alone writes `cancelled`; payment and refund endpoints alone write
financial facts. Legacy `paid` and `confirmed` values remain readable but are
not created by the lead-status endpoint. The endpoint rejects price and
payment fields so they cannot replace booking or payment records.

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
- one owner package/price edit is reflected by the FastAPI catalog read and public site while existing booking price snapshots remain unchanged;
- a partial and full refund with reason/time/actor, retries, and an over-refund rejection;
- cancellation/release remains separate from refund, and net payment totals agree across CRM and API;
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

## Local handover files

The current local inventory, architecture, access-variable names, runbook,
migration status, security closeout, and owner decision are in `docs/handover/`.
They distinguish verified local implementation from production steps that
still need external access or owner approval.
