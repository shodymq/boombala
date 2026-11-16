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

## Verification (what each level proves)

| Level | What | Result |
| --- | --- | --- |
| 1. unit | `npm test` | 334 pass |
| 2. mock browser | `e2e/crm-calendar-timeline.e2e.mjs` against `e2e/support/mock-fastapi-calendar.mjs` (a stand-in, not the kernel) | 37/37 (main), legacy whole-hour and API-failure modes pass |
| 3. real FastAPI + PostgreSQL, local | FastAPI `BoomBalaApp` main 6edf03a on a local PostgreSQL (synthetic seed from `ops/staging/seed`): `crm-calendar` 29/29, `crm-actions-security` 8/8, `crm-lost-response` 15/15, `crm-race` 9/9, `crm-full-path` (MFA required) 18/18 | pass. This is a local stack, not the VPS staging |
| 4. staging browser | the same suites via `ops/staging/e2e.sh` on the VPS | not run (no access from this session) |
| 5. production read-only smoke | none | not run |

Real-kernel finding: `confirm` with `13:30` or `16:40` returns `422 invalid_start_time` (see FastAPI dependencies). `crm-full-path` asserts that refusal; set `E2E_KERNEL_MINUTES=1` once the kernel accepts any minute and it asserts success instead.

Fixed while running the real stack: the one-time `ok`/`reservation`/`error` address parameters were put back by the framework's own address commit after a server action, so a refresh replayed the "booking created" notice. `crm-flash-clean.tsx` now cleans after the commit. The side panel also got keyboard handling (focus on open, Escape, Tab trap).

Screenshots: `docs/platform/calendar-screens/`.
