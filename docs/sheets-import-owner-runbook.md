# Runbook: reconcile the Google Sheets with production (read-only)

Roles and what they can actually do (from the checked VPS setup):

| Who | Where | Rights used |
| --- | --- | --- |
| **You, on the Mac** | your Mac | `ssh`/`scp` as `codexops` (file copy works; `AllowTcpForwarding no` is irrelevant, no tunnel is used) |
| **`codexops`** | VPS | no sudo, no DB admin: verifies the archive, runs the read-only reconciliation, wipes its own folder |
| **root / DB admin** | VPS | `root` login (provider console or your root access): creates and later removes the temporary DB resources |

Nothing opens PostgreSQL to the network, nothing changes global SSH settings, nothing is imported: no booking, no payment fact,
no migration, no write to any `bb.*` table. The reconciliation reads production inside a `READ ONLY` transaction.

## What the DB admin step really changes on the production cluster (infrastructure, not data)

- role `bb_sheets_ro` (read-only, 2 connections, new logins valid 12 h), column-level `SELECT` grants and one `SELECT`-only policy
  `sheets_ro_select` on `bb.rooms/packages/lead_requests/contacts/slot_reservations/time_slots` (the last only before migration 015);
- a **separate** database `bb_sheet_staging` and its own role `bb_sheets_stage` (no access to `bb.*`), which will hold the importer's staging
  rows, i.e. **personal data from the sheet**, until the admin cleanup.

Fail-closed rules: if any of those names already exists, `prepare` changes nothing and stops. `cleanup` removes only what a recorded
`prepare` created and compares PostgreSQL object ids first, so it never drops an existing or re-created object. A failed `prepare`
removes only what it had created. `VALID UNTIL` only blocks new logins; `cleanup` is what drops the role and ends its sessions.

Use a **fresh CSV export** (the sheet may have changed since the last analysis): in Google Sheets, File → Download → CSV.
`<SHA…>` values below are given to you in the chat by Claude, **not** taken from the files you copy.

## A. On your Mac

```bash
cd ~/Documents/BoomBalaAll/wt-sheets-import/platform/dist-vps
shasum -a 256 sheets-import-vps.tgz sheets-verify-archive.sh      # compare with the two values from the chat
VPS=codexops@YOUR_VPS_ADDRESS
ssh $VPS 'mkdir -m 700 ~/sheets-recon'
scp sheets-import-vps.tgz sheets-verify-archive.sh $VPS:sheets-recon/
scp "$HOME/Downloads/Банкеты - Лист1.csv" $VPS:sheets-recon/banquets.csv
ssh $VPS 'chmod 600 ~/sheets-recon/banquets.csv'
```

## B. On the VPS as `codexops`: verify, then extract

```bash
cd ~/sheets-recon
less sheets-verify-archive.sh                                      # short, readable; q to quit
bash sheets-verify-archive.sh sheets-import-vps.tgz <SHA-OF-TGZ-FROM-CHAT>
```

It checks the SHA-256, rejects absolute paths, `..`, symlinks, hardlinks and any unexpected entry, lists the file names (no contents),
refuses to overwrite an existing `bundle/`, and only then extracts into `~/sheets-recon/bundle`.

## C. On the VPS as root / DB admin: create the temporary access

```bash
install -d -m 700 /root/sheets-admin/sql
cp /home/codexops/sheets-recon/bundle/scripts/sheets-db-admin.sh /root/sheets-admin/
cp /home/codexops/sheets-recon/bundle/scripts/sql/sheets-ro-grant.sql /root/sheets-admin/sql/
cd /root/sheets-admin && sha256sum sheets-db-admin.sh sql/sheets-ro-grant.sql   # compare with the two values from the chat
less sheets-db-admin.sh sql/sheets-ro-grant.sql                                  # review what will run
./sheets-db-admin.sh status                                                      # everything should be "absent"
./sheets-db-admin.sh prepare codexops /home/codexops/sheets-recon
```

Root runs the copies in `/root/sheets-admin`, not the files in codexops' folder, so codexops cannot change what root executes.
`prepare` prints no secret; it writes `ro.url` and `stage.url` (mode 600, owner `codexops`) into `~/sheets-recon`.
Assumed: PostgreSQL on `127.0.0.1:5432`, database `boombala`, `runuser -u postgres -- psql` works, password logins allowed on 127.0.0.1
(`scram-sha-256`). Otherwise set `DB_PORT`, `DB_NAME` or `PSQL_ADMIN='psql -X -q -v ON_ERROR_STOP=1 -d …'` before the command.

## D. On the VPS as `codexops`: reconcile

```bash
cd ~/sheets-recon/bundle/scripts
./sheets-vps-run.sh ~/sheets-recon/banquets.csv --expect-leads 48 --expect-bookings 0
```

- `--expect-bookings` counts **active confirmed bookings only**; manual blocks are counted separately and printed as `activeBlocks`
  (add `--expect-blocks N` if you know it). 0 bookings does not mean every room is free.
- On a count mismatch the run stops before staging and prints the real numbers. Do not just rerun with them: first confirm independently
  (more real requests than 48 is normal; fewer, or an empty CRM, is not). An empty CRM snapshot is refused outright.
- Add `--hours 10:00-23:00` (the branch's real hours) to also flag bookings outside working hours.
- Output is counts only (it includes the CSV's SHA-256 and row count so you can tell which export was used). The row-level report is
  `~/sheets-recon/reports/*.json` (mode 600, personal data): it stays on the VPS.

## E. Send Claude the printed output (counts only), then clean up

1. Root / DB admin: `cd /root/sheets-admin && ./sheets-db-admin.sh cleanup && ./sheets-db-admin.sh status`
   (removes the role, the policies, the staging database and role, and shreds the credential files; `status` must say `absent`).
2. `codexops`: `bash ~/sheets-recon/bundle/scripts/sheets-wipe.sh ~/sheets-recon`
   (shreds the CSV, reports and archive and removes the folder; it refuses to run while the credential files still exist, and it keeps
   any file it does not know). Keep the report only if the manager review needs it, and delete it afterwards.
3. Root: `rm -rf /root/sheets-admin` once you no longer need the script.
