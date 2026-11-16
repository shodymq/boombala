# Owner runbook: reconcile the Google Sheets with production (on the VPS)

Everything runs on the VPS itself. PostgreSQL is reached over `127.0.0.1`: no SSH tunnel, no open port, no change to sshd.
One command creates a temporary read-only role, runs the comparison, and removes the role again (also if the run fails).
Nothing is imported: no booking and no payment fact is created, and nothing in `bb.*` is written.

What the temporary role can read: rooms and packages (id, name), requests (id, date, number of children, package, room, status),
contacts (id, normalized phone, name key) and reservations (id, kind, room, contact, time, release flag, children, package).
No amounts, payments, comments or other contact fields. It has SELECT-only row policies on exactly those tables; no BYPASSRLS.
The importer keeps its own state in a **separate database** `bb_sheet_staging` with its own role, which cannot read `bb.*`.

Needs on the VPS: Node 22.6+ (`node -v`), `psql`, `openssl`, `sudo` to the `postgres` user, PostgreSQL on `127.0.0.1:5432`
accepting password logins there (`scram-sha-256`, the default). Replace `USER@VPS` with your SSH login.

## 1. On your Mac (two copies; the CSV holds personal data, so it goes straight to your own server)

```bash
scp ~/Documents/BoomBalaAll/wt-sheets-import/platform/dist-vps/sheets-import-vps.tgz USER@VPS:~/
scp "$HOME/Downloads/Банкеты - Лист1.csv" USER@VPS:~/banquets.csv
```

## 2. On the VPS (one command; enter your sudo password if asked)

```bash
tar -xzf ~/sheets-import-vps.tgz -C ~ && cd ~/bundle/scripts
./sheets-vps-run.sh ~/banquets.csv --expect-leads 48 --expect-reservations 0
```

`--expect-leads` and `--expect-reservations` are the production counts you gave earlier. If the real numbers differ, the script
stops before staging and prints the actual counts; check which side is right and rerun with the correct numbers.
Add `--hours 10:00-23:00` (use the branch's real working hours) to also flag bookings outside working hours.

## 3. Send Claude the output

Paste what the command printed into the chat. It contains counts only (no names, phones or amounts). The row-level report stays on the VPS as
`~/sheets-report-<time>.json` (mode 600). Do not paste or send it unless the manager review needs it.

## Done / cleanup

- The temporary role is revoked automatically at the end (the script prints `temporary read-only role revoked`; it would also expire after 2 hours).
- Check any time: `./sheets-ro-role.sh status` should say `role bb_sheets_ro: absent`.
- When the whole reconciliation is finished, remove the staging database and the report:
  `./sheets-ro-role.sh stage-drop && shred -u ~/sheets-report-*.json ~/banquets.csv`

## If something differs

- Admin command or database name: `PSQL_ADMIN='sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d OTHERDB' DB_NAME=OTHERDB ./sheets-vps-run.sh ...`
- Another PostgreSQL port: `DB_PORT=5433 ./sheets-vps-run.sh ...`
- Older Node (22.6 to 22.17) is handled automatically; older than 22.6 is refused with a message.
