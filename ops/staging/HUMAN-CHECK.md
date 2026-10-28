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

## Checklist (about 25 minutes, each manager does their part)

Use a date the operator gave you. Use only the test names the operator gives you (for example "Тест Клиент 1").

**Manager A**
1. Open the calendar: both branches are in the list; the grid loads; no error banner.
2. Create a booking: Room A, 14:00, price 180 000 ₸, prepayment 20 000 ₸, cash. Expect the green line "Проверено по данным системы".
   The booking card shows the prepayment "записана вручную ... (не онлайн-оплата)".
3. Reload the page three times. The green line does not come back, and the booking stays once.
4. Try to create another booking for the same phone at another time. Expect a message about an unconfirmed paid request
   and no new request. Do not pay twice.

**Manager B** (second browser or private window)
5. See A's booking in the list with the responsible name.
6. Try Room A at 16:00 for another client: expect "Комната занята". Nothing new appears.
7. Cancel A's booking (Отменить бронь). It stays in the day list as "Отменено"; the room is free in the grid.
8. Book Room A at 16:00 for another client: expect success after the green check.

**Both**
9. Sign out, then open the calendar address: you must land on the login page.
10. Sign in again: the calendar loads.

## What to report

- Each numbered item: pass or fail, the time, and the test date.
- Any success line you did not see on the grid, any duplicate booking or payment, and any other person's data on screen.
- Anything the calendar did not explain.

Send the report to the operator only. Do not paste credentials, tunnel commands with passwords, or screenshots that show a login page
with a password field filled in.

## Do not

- Do not try to reach other ports, the production sites, the production database or any public address.
- Do not change settings, accounts or passwords. Ask the operator.
- Do not enter real names, phones, prepayments or consent data.
