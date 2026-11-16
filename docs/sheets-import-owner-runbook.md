# Temporary read-only access for the Sheets reconciliation

Goal: compare all 168 sheet rows with production without changing a single production row. Nothing here applies a migration
(production is still pre-015; the importer reads that schema as it is). The role sees only the columns the matcher needs: no
amounts, payments, comments, children's details or other contact fields. It expires by itself after `TTL_HOURS` (default 48).

Replace `USER@VPS` with your SSH login. Assumptions: PostgreSQL runs on the VPS, the database is `boombala`, the port is 5432
and `sudo -u postgres psql` works there. If not, see "If something differs".

## 1. On your Mac: copy the two files to the VPS

```bash
cd ~/Documents/BoomBalaAll/wt-sheets-import/platform
ssh USER@VPS 'mkdir -p ~/sheets-ro'
scp -r scripts/sheets-ro-role.sh scripts/sql USER@VPS:~/sheets-ro/
```

## 2. On the VPS: create the role

```bash
cd ~/sheets-ro && chmod +x sheets-ro-role.sh
./sheets-ro-role.sh status
TTL_HOURS=24 ./sheets-ro-role.sh create
```

`create` prints one line and writes the connection URL to `~/.bb_sheets_ro.url` (mode 600). The password is generated on the
VPS, goes to PostgreSQL through stdin, and is never printed or kept anywhere else. Re-running `create` is refused until `revoke`.

## 3. On your Mac: fetch the URL file (not through chat) and open a tunnel

```bash
mkdir -p ~/.config/boombala && chmod 700 ~/.config/boombala
scp USER@VPS:~/.bb_sheets_ro.url ~/.config/boombala/sheets_ro.url && chmod 600 ~/.config/boombala/sheets_ro.url
ssh USER@VPS 'shred -u ~/.bb_sheets_ro.url'
ssh -N -L 55432:127.0.0.1:5432 USER@VPS
```

Leave the last command running in its own Terminal tab (it is the tunnel). The URL already points to `127.0.0.1:55432`.

## 4. Tell Claude

Write only: "доступ готов, файл ~/.config/boombala/sheets_ro.url". Claude reads the file inside its own shell, never prints it,
checks the role with the built-in preflight, and runs the reconciliation. Do not paste the URL or password in chat.

## 5. When Claude reports it is finished: revoke

```bash
ssh USER@VPS 'cd ~/sheets-ro && ./sheets-ro-role.sh revoke'
rm -f ~/.config/boombala/sheets_ro.url
```

Then close the tunnel tab (Ctrl+C). `revoke` terminates the role's sessions, drops its grants and the role, and removes the URL file.
If you forget, the role stops working after `TTL_HOURS` anyway.

## If something differs

- Other admin command or database name: `PSQL_ADMIN='sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d OTHERDB' DB_NAME=OTHERDB ./sheets-ro-role.sh create`.
- PostgreSQL on another port: change `5432` in the tunnel command.
- `pg_hba.conf` must allow `127.0.0.1` with `scram-sha-256` (the default on most installs).
- Do not run migration 015 for this. The grant detects the schema and grants the right columns by itself.
