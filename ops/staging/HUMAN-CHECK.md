# Safe staging check by a person (manager pilot rehearsal)

This is the checklist for a human reviewer. It uses synthetic test data only. Never enter real client names, phones or payments.

## 1. Open the tunnel from your Mac

Your `~/.ssh/config` may set `ClearAllForwardings yes` for `boombala-claude`. Forwarding for this one session is your decision.
Run this in your own terminal, then leave it open:

```bash
ssh -N -o IdentitiesOnly=yes -o ClearAllForwardings=no -L 127.0.0.1:3400:127.0.0.1:3400 boombala-claude
```

Port 3400 is the CRM on the staging host. It is reachable only from your Mac through this tunnel.

## 2. Sign in with a test account

Use one of the synthetic staff accounts: `manager-a@staging.boombala.example.com` or `manager-b@...`. The password is given to you
out of band (it is not stored in this repository). Owner accounts exist only for administrators.

Open `http://127.0.0.1:3400/login`.

## 3. Checklist (about 20 minutes)

1. Calendar loads for the branch, both branches are listed, no 403 or "Не удалось загрузить".
2. Create a booking on the test date for 14:00 in Room A (price 180 000, prepayment 20 000, cash). A green line says it was checked
   against the system. The day list shows the booking with "предоплата записана вручную ... (не онлайн-оплата)".
3. Open a second browser profile or a private window, sign in as the other manager, try 16:00 in Room A: it is refused with
   "Комната занята". Nothing new appears.
4. Reload the page several times. The success line does not come back.
5. Press the browser back button after a booking. Nothing is booked twice.
6. Cancel the booking. It stays in the list as "Отменено"; the room is free again.
7. Try to open the page with a changed `date` or `branch` in the address bar: no data from another branch is shown without the
   catalog allowing it.
8. Sign out, then try the calendar address: you must be sent to the login page.

## 4. What to report

- Pass/fail for each item, the time, and a screenshot (blur any personal data first; the data here is synthetic anyway).
- Anything that shows a success you did not see on the grid.
- Anything that shows another person's data.

## 5. Do not

- Do not try to reach the production sites, the production database or any other port on the staging host.
- Do not change settings, passwords or accounts. Ask the operator.
