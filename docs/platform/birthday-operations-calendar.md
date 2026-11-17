# Birthday operations calendar (CRM)

The day view replaces the paper journal: time runs down, the four rooms run across, a booking is a block at its exact minutes.
It is built on PR #51 (FastAPI-backed CRM calendar) and reads and writes only through the existing FastAPI client and server actions.
There is no frontend-only source of bookings.

## What the screen does

- Positions use exact minutes (`bk-top-<minutes>` / `bk-h-<minutes>` utilities, no inline styles because of the CSP). 13:30, 16:40 and 17:07 are not rounded.
- Colours: green = confirmed with a recorded manual prepayment; amber = confirmed, no prepayment recorded; hatched grey = block; red = overlap that must not exist.
- Requests without a confirmed room and time are listed under the grid and never occupy a room.
- A failed read shows an error and no grid. A failed request read shows "no data", never zero.
- Success is shown only after the page reads the reservation (and its manual payment fact) back from FastAPI.
- Create, reschedule and release go through the existing actions; the submit button is disabled while pending and every form carries an idempotency key.
- Staff roles that FastAPI does not allow to see client data get "Клиент скрыт" and no phone.

## Dependencies on FastAPI (for Codex; not changed in this PR)

1. `birthday_bookings/intervals.py`: `START_STEP_MINUTES = 60` is enforced in `parse_start_time` and `validate_booking_window`. Starts such as 13:30 or 16:40 are answered with `422 invalid_start_time`. The UI shows that refusal and does not fake a booking. Set the step to 1 minute (and review migration 015 / availability generation, which assume whole hours).
2. The timeline does not return child name and age, children/adult counts, animator or a change history. The card says so instead of inventing values. The child name typed in the form is saved in the comment.
3. Booking creation is three calls (request, manual payment, confirm). When confirm is refused (for example `invalid_start_time` on today's FastAPI) the request and the 10 000 ₸ prepayment already exist. The UI discloses this and offers "confirm without a new prepayment". A validate-only (dry-run) endpoint, or validation before the payment is written, would remove that state.
4. Open requests are counted from `GET /admin/leads` filtered client-side by `requestedDate`; there is no server filter or reliable `total` for that, so a long list is marked "N+".

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `e2e/crm-calendar-timeline.e2e.mjs` against `e2e/support/mock-fastapi-calendar.mjs` (a stand-in for the FastAPI contract; it is not the booking kernel). Screenshots: `docs/platform/calendar-screens/`.
The older staging scripts `crm-calendar`, `crm-actions-security` and `crm-lost-response` still target the previous page layout (inline forms, `select[name=startTime]`) and need updating when a staging environment is available; they were not run here.
