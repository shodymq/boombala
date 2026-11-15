# Manual check of the closed synthetic staging (two managers)

Scope: synthetic branches, rooms, clients and prepayments only. No real client data, no production systems, no public domain.
Accounts are created by the operator on the staging host. **Passwords are not written in this file or in any chat.** The operator
gives each manager their own login out of band.

## Before you start (operator)

1. Open the tunnel on your own Mac with your own SSH settings (`ClearAllForwardings=no` is needed on this host):
   `ssh -N -o IdentitiesOnly=yes -o ClearAllForwardings=no -L 127.0.0.1:3400:127.0.0.1:3400 boombala-claude`
2. Or share your screen; the managers then work in your browser session. Do not share the SSH agent or key files.
3. Tell managers the test date range. Each check uses fresh days, so use a new range for each session.

## Login

- Address: `http://127.0.0.1:3400/login` (only reachable through the tunnel).
- Manager A and manager B each have their own pilot account (the operator gives you the email and password).
- Do not use owner accounts. Do not change the password.

## Checklist (about 35 minutes, each manager does their part)

Use a date the operator gave you. Use only the test names the operator gives you (for example "Тест Клиент 1").

**Manager A**
1. Open the calendar: both branches are in the list; the grid loads; no error banner.
2. Create a booking: Room A, 10:00–14:00, price 180 000 ₸, fixed manual prepayment 10 000 ₸, cash. Expect the green line "Проверено по данным системы".
   The booking card shows the prepayment "записана вручную ... (не онлайн-оплата)".
3. Try Room A at 15:30. The request is rejected by the backend rule; no reservation or payment fact is added.
4. Create Room A at 14:00–18:00 after the 10:00–14:00 booking. The exact boundary is allowed because buffer is 0.
5. Try Room A at 13:00–17:00. Expect "Комната занята"/409; no second reservation or payment fact is added.
6. Create Room B at 10:00–14:00. It is allowed; verify the grid shows all four private rooms and only the selected room is occupied.
7. Reload the page three times. The verified line does not come back as a new mutation, and each booking stays once.
8. Try to create another booking for the same phone and date. Expect a message about an unconfirmed paid request
   and no new request. Do not pay twice.

**Manager B** (second browser or private window)
9. See A's booking in the list with the responsible name and the manual-prepayment status.
10. Try to confirm the same room/time as A: expect "Комната занята". Nothing new appears.
11. Reschedule an existing booking to a free HH:00 start and verify the old cell is free and the new cell is occupied.
12. Cancel A's booking. It stays in the day list as "Отменено"; the room is free in the grid.
13. Book the released room at a valid HH:00 start: expect success after the green check.
14. Attempt a manual block with the manager account. It must be denied if the account has no block permission; do not grant a role during UAT.

**Both**
15. Sign out, then open the calendar address: you must land on the login page and Server Actions return no success.
16. Sign in again: the calendar loads and the previous staff identity is not reused after logout.

**Owner / return control**
17. The Owner can see staff and the audit journal; a manager cannot elevate their role or access Owner-only pages.
18. Cancellation is not a refund. Until an approved refund endpoint and accounting process exists, do not mark a booking as refunded in CRM and do not enter a fake return; verify that the real return is handled in the approved cash/accounting process and attach only the resulting audit reference.

## What to report

- Each numbered item: pass or fail, the time, and the test date.
- Any success line you did not see on the grid, any duplicate booking or payment, and any other person's data on screen.
- Anything the calendar did not explain.
- Any attempt to use 15:30, a non-zero buffer, a fake refund, or a manager-only action that was accepted.

Send the report to the operator only. Do not paste credentials, tunnel commands with passwords, or screenshots that show a login page
with a password field filled in.

## Do not

- Do not try to reach other ports, the production sites, the production database or any public address.
- Do not change settings, accounts or passwords. Ask the operator.
- Do not enter real names, phones, prepayments or consent data.
