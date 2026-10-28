# CRM calendar: FastAPI contract used by the Platform

Source: `BoomBalaApp` `feat/crm-calendar-buffer` (c1b7a73). All calls go from the Platform server only, with a
short-lived staff access token from `POST /api/v1/admin/auth/service/staff-access-token`.

## Calls used by the calendar

| Action | Method and path | Body or query |
|---|---|---|
| Timeline | `GET /admin/birthday-bookings/timeline` | `branchId`, `date` (YYYY-MM-DD) |
| Create request | `POST /admin/birthday-requests` (201) | `branchId`, `packageId`, `customerName`, `phone`, `guestCount?`, `requestedDate?`, `notes?`, `idempotencyKey` |
| Manual prepayment | `POST /admin/birthday-requests/{id}/manual-payments` | `amountKzt`, `method` (`cash`, `card_terminal`, `bank_transfer`, `other_manual`), `idempotencyKey`, `note?` |
| Confirm (four hours) | `POST /admin/birthday-bookings/confirm` | `requestId`, `bookingDate`, `roomId`, `startTime` (HH:MM, 15-min step), `packageId`, `agreedPriceKzt`, `idempotencyKey`, `note?` |
| Block (four hours) | `POST /admin/birthday-slots/block` | `branchId`, `bookingDate`, `roomId`, `startTime`, `reason`, `idempotencyKey` |
| Reschedule | `POST /admin/birthday-reservations/{id}/reschedule` | `startTime`, `bookingDate?`, `roomId?`, `idempotencyKey` |
| Release (cancel or unblock) | `POST /admin/birthday-reservations/{id}/release` | `reason?`, `idempotencyKey` |
| Packages | `GET /admin/birthday-packages` | list query |
| Branches | `GET /admin/branches` | list query |

## Error codes the calendar maps to Russian messages

`time_conflict`, `slot_taken`, `outside_working_hours`, `branch_hours_unknown`, `start_in_past`,
`invalid_start_time`, `birthday_prepayment_required`, `birthday_request_not_bookable`,
`birthday_request_not_payable`, `request_already_booked`, `reservation_not_found`,
`reservation_already_released`, `room_not_configured`, `package_not_configured`, `idempotency_conflict`,
`idempotency_in_progress`, `authorization_required`, `branch_access_denied`, `validation_error`,
`crm_service_unavailable`. Any other code shows a generic failure. Nothing is shown as success unless FastAPI returned 2xx.

## Backend gaps (for the BoomBalaApp owner)

1. **One live bridge session per staff member.** Each token issue revokes the previous `crm_bridge` session of the
   same staff member (`revoke_active_bridge_sessions`). Two open browser tabs, or a calendar load next to an action,
   therefore invalidate each other. The Platform works around it with a server-only cache per Platform session, but
   the cache only helps on one process. Requested: allow a bounded number of live bridge sessions per staff member
   (for example, one per Platform session id), or a refresh endpoint for a bridge session.
2. **Branch scope on the list endpoints.** `GET /admin/branches` must return only the caller's branch for an operator
   (`branch_id` on the admin row). Otherwise the picker shows branches the operator must not work with. Timeline and
   writes are already scoped server-side, so this is a UX gap, not a leak.
3. **Buffer in the timeline.** The timeline does not return the branch's `bufferMinutes` or each reservation's
   `occupiedEndsAt`. The calendar cannot show the buffer. Requested: add both fields (read-only).
4. **Reservation state after prepayment.** Requested: a `paymentStatus` value on each timeline reservation
   (`unpaid`, `prepaid`) so the calendar shows an unpaid confirmed booking as a warning, not a fact.

5. **Catalog read for booking roles (blocker for sales managers).** Checked on the staging stack on 2026-10-28:
   `GET /admin/branches` and `GET /admin/birthday-packages` return `403 insufficient_role` for `sales_manager`, while the
   timeline works for them. A sales manager therefore cannot pick a branch's package and cannot open the create form.
   Requested: a read endpoint for the booking roles, for example `GET /admin/birthday-bookings/catalog?branchId=`, that
   returns the caller's branches, the active rooms and the active packages (id, name, price_from, price_label). The
   Platform must not take the catalog from its own database: a package id must be the FastAPI id.
6. **Operator branch scope.** An operator gets `403 branch_access_denied` for another branch's timeline (correct), and
   the branch list is 403 for the operator (as above). Requested: the catalog endpoint in item 5 returns only the
   operator's assigned branch.
7. **Responsible manager name.** The timeline returns `createdByAdminId` only. The calendar needs a display name for the
   responsible manager. Requested: `createdByName` on each reservation, or the admin's name in the timeline response.

Nothing else blocks the calendar. The Platform does not add backend endpoints and does not write to the database
for booking operations.
