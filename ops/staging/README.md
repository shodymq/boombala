# Boom Bala CRM: isolated staging for the manager pilot

This folder reproduces the staging stack that the manager E2E runs against. It is **not** production and must never point at
production data. Everything binds to `127.0.0.1`; managers reach it through an SSH tunnel, not through nginx or DNS.

## What runs

| Part | Where | Notes |
| --- | --- | --- |
| PostgreSQL 17 | own cluster, `$STAGING_ROOT/pgdata`, port `STAGING_PG_PORT` | Separate cluster; the production cluster is not used. |
| FastAPI admin kernel | `BACKEND_DIR` at `BACKEND_SHA`, port `STAGING_FASTAPI_PORT` | Owns bookings, the bridge and PostgreSQL invariants. |
| Platform CRM | `PLATFORM_DIR` at `PLATFORM_SHA`, port `STAGING_PLATFORM_PORT` | Next.js; reaches FastAPI only through the server-side bridge. |

Live services that must keep working and are never touched: `bb-admin` (3100), `bb-api` (3101), `bb-site` (3000), the production
PostgreSQL (5432), nginx (80/443). `guard.sh` refuses to start if staging would use one of those ports or a production database name.

## Prerequisites (VPS user `boombala-staging`, not root)

The VPS user has no sudo. Things that need root are therefore replaced by user-level equivalents:

- No `python3-venv`: create the venv with `python3 -m venv --without-pip venv`, then bootstrap pip with `get-pip.py` into it.
- BoomBalaApp is a private repository. Move the pinned commit as a bundle: `git bundle create backend.bundle <sha>` on the
  operator's Mac, `scp` it to `~/boombala-staging/incoming/`, then `git clone backend.bundle` and check out the SHA.
- PostgreSQL binaries come from `/usr/lib/postgresql/17/bin`; the staging cluster uses its own data directory, port and socket
  directory (`pg.sh` sets `unix_socket_directories` to `$STAGING_ROOT/run`, because the system socket directory belongs to
  the production cluster).

- Ubuntu 24.04 with PostgreSQL 17 server binaries (`initdb`, `pg_ctl`, `pg_dump`, `psql`), Node 22.18+ (`engines`), Python 3.11+.
- Two checkouts at pinned SHAs: BoomBalaApp (`backend/`) and boombala (`platform/`). `staging.env` records the SHAs.
- A Python venv for the backend at `$STAGING_ROOT/venv` with the backend requirements installed.
- `npm ci` in `PLATFORM_DIR` (the lockfile pins Next 16.4.3 and the audited dependency set).

## Run it (first time)

```bash
cp staging.env.example staging.env          # edit paths and SHAs; keep it out of git
./gen-secrets.sh                            # staging-only secrets, mode 600, values not printed
./pg.sh init                                # new cluster in $STAGING_ROOT/pgdata
./pg.sh start
./guard.sh                                  # must print "guard ok"
./migrate.sh                                # platform then FastAPI migrations
STAGING_TEST_PASSWORD='<12+ chars, test only>' ./seed.sh
./up.sh                                     # FastAPI and Platform on 127.0.0.1
```

Then open an SSH tunnel from the operator's Mac (manager browsers use `http://127.0.0.1:<port>` on the Mac):

```bash
./tunnel.sh boombala-claude                 # Ctrl-C to close
```

`tunnel.sh` refuses when the host entry in `~/.ssh/config` sets `ClearAllForwardings yes`, because that setting disables
port forwarding on purpose. To use the tunnel anyway, review the host entry and run `ALLOW_FORWARDING=1 ./tunnel.sh <host>`
for that session only.

Check the stack from the VPS itself (no browser, no secrets printed):

```bash
./smoke.sh                                  # FastAPI and Platform answer; linked manager gets a token; identity mismatch refused
```

## Stop, back up, restore, roll back

Verified on the VPS at the pinned SHAs: `backup.sh` then `restore-test.sh` (both databases restore and match table counts), the
race E2E (`npm run e2e:crm-race` against the VPS FastAPI and database: 9/9), `smoke.sh` (4/4), and `rollback.sh` to the previous
SHA pair and back.


```bash
./down.sh                                   # stops FastAPI and Platform; keeps data
./backup.sh                                 # both databases, custom format, SHA256SUMS
./restore-test.sh                           # restores the newest backup to scratch databases and compares table counts
./rollback.sh <fastapi-sha> <platform-sha>  # previous recorded pair; data is kept; see note below
```

**Rollback note.** Rolling back the code does not revert the schema. If a migration must be undone, restore the backup taken
before it (`restore-test.sh` proves the dump is usable; restoring into the live staging databases is a manual, deliberate step).
`$STAGING_ROOT/releases/history.log` records every start and rollback with the SHAs that ran.

## Synthetic data only

`seed/` holds the synthetic seed: branches `stg-almaty` and `stg-shymkent`, rooms, packages, FastAPI admins (`stg-owner-a`,
`stg-owner-b`, `stg-manager-a`, `stg-manager-b`, an operator), and Platform staff linked explicitly to them. `seed_calendar.py`
truncates the staging admin tables; it refuses nothing by itself, so run it only through `seed.sh`, which runs `guard.sh` first.
The seeded `password_hash` values are placeholders: the bridge does not check them. Platform passwords come from
`STAGING_TEST_PASSWORD`, which is test-only and must never be a real credential.

## Verification

Run from the Platform checkout after `up.sh`:

```bash
npm run e2e:crm-calendar    # manager E2E, two browser contexts
npm run e2e:crm-race        # real FastAPI race
npm run e2e:crm-security    # cross-origin action refused, repeat submit
```

The E2E scripts read `PLATFORM_URL`, `E2E_PASSWORD`, `PLATFORM_DATABASE_URL`, `FASTAPI_DATABASE_URL`, `E2E_CRM_SERVICE_TOKEN`,
`E2E_CRM_STAFF_ASSERTION_SECRET`, `E2E_ARTIFACTS` and `E2E_DATE` from the environment. Use a new `E2E_DATE` per run.

## Automated start (optional)

`boombala-staging.service` is a systemd user unit template. Copy it to `~/.config/systemd/user/`, then
`systemctl --user daemon-reload && systemctl --user start boombala-staging`. Linger must be enabled for it to survive logout.
