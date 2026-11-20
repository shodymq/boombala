# Temporary Google Sheets → CRM sync

The sync reads only the official Google Sheets v4 API (`spreadsheets.readonly`) and writes calendar **blocks** through the existing `legacy-bridge` booking writer. It does not create leads, confirmed bookings, or payment facts. Production stays disabled until the dry-run, manager reconciliation, migration, and credential provisioning are complete.

## Source identity and reconciliation

Rows are never keyed by sheet row number. For already-imported legacy blocks, the worker can adopt a single matching historical source snapshot using a keyed digest of normalized phone + client name + child name. A row with more than one possible legacy match is held for manual review. **Every new row requires a fixed `CRM Sync ID` / `ID синхронизации` value before automatic writes.** A bound Google Apps Script assigns UUIDs when managers add business data, so managers do not fill technical IDs manually. The owner installs its triggers and authorizes its limited scopes once; the service account used by the VPS remains read-only. New rows without an ID are held for review rather than risking a duplicate if contact fields later change. Changing a natural identity on an already adopted row also requires manual reconciliation. Existing one-shot blocks are matched and indexed without creating another block.

The worker preserves exact venue wall time (Asia/Almaty, UTC+05:00), applies a four-hour interval, and checks working hours and overlaps. `Общий зал` and `Общий зал 2 этаж` are explicitly shared zones; simultaneous events there are allowed. A source deletion marks the row `source_missing`; it never releases a reservation. Conflicts, unknown data, and non-unique identities go to manual review.

While enabled, staff reschedule/release operations refuse sync-managed reservations. Updates from Sheets use the same atomic reschedule transaction as the existing writer; if the destination conflicts, the old block remains. Disabling the sync restores normal CRM editing.

## Provisioning and first dry-run

### Owner setup for stable IDs

The owner of the spreadsheet performs this once; it modifies the source by adding a protected `CRM Sync ID` column and filling UUIDs for existing non-empty rows. The service account does not have write access.

1. Open the source spreadsheet and choose **Extensions → Apps Script**.
2. Add `Code.gs` from `deploy/kz/google-apps-script/Code.gs`. In **Project Settings**, show `appsscript.json` and replace its contents with the checked-in manifest from the same directory.
3. In **Project Settings → Script properties**, add `CRM_SYNC_EXPECTED_SPREADSHEET_ID` with the spreadsheet ID copied from its URL. Save the project. The ID is a locator, not a credential; the script uses it only to refuse execution against a different spreadsheet.
4. Select `setupCrmSyncIdAutomation` and click **Run** while signed in as the spreadsheet owner. Review the OAuth scope request and approve it as the owner. The script checks the configured spreadsheet ID and owner account before changing anything.
5. Confirm the `CRM Sync ID` column was appended to `Лист1`, existing non-empty rows received UUID values, and that column is protected from manager edits. Two installable triggers then fill IDs when rows are edited, pasted, or inserted. If a copied row carries the source UUID, the trigger keeps the existing row's UUID and issues a different one to the copied row.
6. Sorting must keep each row's ID attached to its business fields. Use a filter view or sort the full table range including the protected `CRM Sync ID` column; do not sort only a subset of business columns. The change trigger rescans the full used range after sort/structural `OTHER` changes and repairs blank or duplicate IDs.
7. Do not copy the ID column to another sheet, clear it, or regenerate IDs. Verify the column has one unique UUID per non-empty business row after copy/sort tests. If a trigger fails, stop and have the owner inspect Apps Script Executions; do not bulk-clear the column.

If the spreadsheet is in a Shared Drive with no individual file owner, this owner-only script stops. Do not weaken its check: have the Drive owner perform an equivalent controlled setup and update the ownership guard in a reviewed change first.

### Google read-only service account

1. In Google Cloud Console, create or select a dedicated project for this integration. Enable **Google Sheets API**.
2. Under **IAM & Admin → Service Accounts**, create a dedicated account. Do not grant project roles; the sheet-level Viewer grant is the only data access required.
3. Under that service account, create a JSON key. Download it once and store it securely; never commit it, attach it to GitHub, or send it in chat.
4. Copy the service account `client_email`. In the spreadsheet’s **Share** dialog, add that exact address as **Viewer**. Keep general access restricted; do not publish the sheet or enable link access.
5. Install the JSON key on the VPS as `/etc/boombala/sheets-reader.json`, owned by `bbadmin:bbadmin` with mode `0600`. Keep the file outside every release and backup report. Do not print the file or key in shell output.
6. Run the server dry-run procedure below with `SHEETS_SYNC_ENABLED=0`. A 403/404 means the Sheet was not shared with the service account or the API is not enabled; no booking writes should occur.

### Migration and first dry-run

1. Apply migration `017_sheets_live_sync.sql` only after staging restore/migration/concurrency checks and normal production change control. It retains existing reservation IDs and defaults current rooms to exclusive. If either shared-zone name/ID already exists under a different catalog contract, migration aborts without changing the old room; reconcile the catalog explicitly first. Run normal DB-role provisioning after migration so `bb_admin` has access to the two new metadata tables.
2. Put the service-account JSON at `/etc/boombala/sheets-reader.json`, owner `bbadmin:bbadmin`, mode `0600`. It is read by the app only; never print or commit it.
3. Add the following values to `/etc/boombala/admin.env` (the CRM process needs the flag to lock source-managed records and the read-only key/HMAC for the Owner button). Create `/etc/boombala/sheets-sync.env`, owner `root:bbadmin`, mode `0640`:

   ```text
   SHEETS_SYNC_ENABLED=0
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/etc/boombala/sheets-reader.json
   SHEETS_SYNC_HMAC_KEY=<random value with at least 32 UTF-8 bytes>
   ```

   Put the same three values in both env files; the timer uses the sync env while the web process uses `admin.env`. Keep the key file `bbadmin:bbadmin 0600`, env files `root:bbadmin 0640`, and do not print either file.

   Keep `SHEETS_SYNC_HMAC_KEY` unchanged once the first dry-run completes. The database stores only its SHA-256 fingerprint and refuses a later key change with `sheets_sync_key_changed`; changing the key would otherwise create a different source-ID namespace and could duplicate imports. Rekeying requires a separate reviewed reconciliation, not an env edit.

4. Create one random `SHEETS_SYNC_HMAC_KEY` with at least 32 UTF-8 bytes and put the same value in both env files. Keep it unchanged after the first dry-run; the DB stores its SHA-256 fingerprint and refuses key changes to prevent a new identity namespace.
5. Install the unit files from `systemd/bb-sheets-sync.service.template` and `systemd/bb-sheets-sync.timer`, then run the CLI once with `--dry-run` as `bbadmin`. Compare each source-row/status/reservation-ID digest in the report with the CRM and all 24 previously imported blocks. Dry-run writes run metadata and a PII-free row reconciliation (row number, keyed digest prefix, status, safe error code, CRM ID); it does not create/reschedule/release reservations.
6. Resolve manual-review and conflict rows with the manager. Only after that approval should the owner set `SHEETS_SYNC_ENABLED=1` in both `/etc/boombala/admin.env` and `/etc/boombala/sheets-sync.env`, restart only `bb-admin.service` to apply its lock, and enable the timer.

The owner-only button on `/sheets-import` runs the same pass. Before the enable flag is set in the admin process environment, it runs dry-run only. Keep both copies of the flag consistent.

## Final cutover: Sheets to CRM

This is the final one-way handoff after managers approve the row-by-row dry-run and the temporary sync has been operating without unresolved conflicts.

1. Announce a Sheets freeze. Managers finish edits and stop creating, moving, or deleting banquet rows. Record the final edit time and do not use a second copy of the spreadsheet as a writer.
2. Run a final dry-run and reconcile every row against the active CRM calendar, including the 24 existing blocks. Resolve conflicts and missing rows with a manager; do not infer confirmation or payment from a Sheet cell.
3. Apply the final approved delta through the sync worker. Verify row count/status totals, source IDs, interval/room, and that existing block IDs remain unchanged. Confirm no manual-review or conflict rows remain unresolved.
4. Stop scheduled/manual sync writes and wait for any active worker to finish:

   ```sh
   systemctl disable --now bb-sheets-sync.timer
   systemctl stop bb-sheets-sync.service
   ```

5. Set `SHEETS_SYNC_ENABLED=0` in both env files and restart only `bb-admin.service`. This unlocks normal staff reschedule/release actions for source-managed blocks; it does not delete blocks or sync history. Verify `/sheets-import` is disabled and the CRM calendar still shows every reconciled event.
6. Make the old Sheet read-only for managers or archive it. Tell staff the handoff time: from then on, CRM is the only booking writer. Do not re-enable the sync after CRM edits begin; a later Sheet import requires a separately reviewed reconciliation.
7. After cutover, verify an Owner/Manager can update and release an imported event through CRM, that audit records the action, and that no sync timer or process is active. Do not create a test payment or a test production event for this check.

## Install, enable, disable

After preparing env and the read-only key:

```sh
install -o root -g root -m 0644 deploy/kz/systemd/bb-sheets-sync.service.template /etc/systemd/system/bb-sheets-sync.service
install -o root -g root -m 0644 deploy/kz/systemd/bb-sheets-sync.timer /etc/systemd/system/bb-sheets-sync.timer
systemctl daemon-reload
```

Keep the timer disabled while reviewing dry-run. To enable after approval, set `SHEETS_SYNC_ENABLED=1`, then:

```sh
systemctl enable --now bb-sheets-sync.timer
systemctl list-timers bb-sheets-sync.timer
```

To stop automatic writes immediately:

```sh
systemctl disable --now bb-sheets-sync.timer
systemctl stop bb-sheets-sync.service
```

Then set `SHEETS_SYNC_ENABLED=0` in both env files and restart `bb-admin.service` so CRM editing is unlocked. Existing imported blocks remain in CRM and are not removed. Review `/sheets-import` before re-enabling.
