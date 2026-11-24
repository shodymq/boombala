# Strict lead pipeline — release runbook

Status: preparation only. No Production database, service, catalog, DNS, timer or deployment was changed while preparing this RC. Run this procedure only after the owner gives the separate Production GO.

## Release contents and gates

- Base RC: `70b4ec8007bb15775dadbd87e803ca6abb1e2532` (integrated Sheets Sync, Birthday CRM V2 and Pricing V4.2).
- This RC adds strict intake persistence for `preferred_start_time`, a CRM read model for it, and a Production-enforced minimal Telegram outbox payload.
- The new field is additive and nullable. Migration 019 adds a new intake-function overload and keeps the old signature, so the preceding site/API can continue to run during rollback.
- Sheets automatic sync remains disabled. Do not enable `bb-sheets-sync.timer`; preserve and verify the 24 known active blocks.
- Production is not cleared for release until the `/privacy` copy below is approved and published. Existing public `/consent` and `/rules` rendered published CRM edition 2; `/personal-data-consent` rendered edition 2 with V1.3 dated 04.11.2026. Browser rendering was checked, but an HTTP status code was not captured.

## 1. Freeze the exact candidate artifact

After this PR is approved for artifact generation, dispatch the existing workflow on the RC branch. It builds only; it has no deployment step:

```sh
gh workflow run release-artifact.yml \
  --ref codex/strict-lead-final-rc \
  -f public_site_url=https://boombala.kz \
  -f booking_calendar=0 \
  -f news=0
gh run list --workflow release-artifact.yml --branch codex/strict-lead-final-rc --limit 3
gh run download <RUN_ID> -D /secure/path/boombala-rc
cd /secure/path/boombala-rc
sha256sum -c boombala-*-linux-x64.tar.gz.sha256
tar -xOf boombala-*-linux-x64.tar.gz boombala-release/RELEASE.json
```

Require Linux `x86_64`, the exact PR head SHA in `RELEASE.json`, `site_profile=kz-production`, the URL above, `booking_calendar=0`, `news=0`, and a passing workflow before copying anything to the VPS. The archive contains `site/` and `platform/`; do not assume it contains server secrets or deploy configuration.

## 2. Pre-change Production snapshot and backup

Use a low-traffic maintenance window. Do not print environment files, connection strings, customer rows, contact values or payment details. Run only aggregate queries for this checkpoint.

Record the current release metadata and active links before touching them:

```sh
readlink -f /opt/boombala/site
ACTIVE_PLATFORM="$(readlink -f /opt/boombala/platform)"
readlink -f /opt/boombala/platform
cat "$(dirname "$ACTIVE_PLATFORM")/RELEASE.json"
systemctl is-active bb-site bb-api bb-admin bb-outbox.timer
```

`RELEASE.json` is non-secret metadata. Capture the following counts from the actual `boombala` database using the approved read-only verifier / owner-only SQL session; never select contact fields:

```sql
SELECT current_database(), current_schema();
SELECT name FROM bb.schema_migrations ORDER BY name;
SELECT count(*) AS contacts FROM bb.contacts;
SELECT status, count(*) AS requests FROM bb.lead_requests GROUP BY status ORDER BY status;
SELECT kind, count(*) AS active_reservations
  FROM bb.slot_reservations WHERE released_at IS NULL GROUP BY kind ORDER BY kind;
SELECT count(*) AS payment_facts FROM bb.manual_payment_facts;
SELECT count(*) AS active_blocks,
       md5(coalesce(string_agg(id::text || '|' || slot_date::text || '|' || room_id || '|' ||
                              starts_at::text || '|' || ends_at::text, E'\n' ORDER BY id), '')) AS block_fingerprint
  FROM bb.slot_reservations WHERE kind='block' AND released_at IS NULL;
```

The previously reported baseline was 473 contacts, 52 requests and 24 active blocks; it is not a substitute for this fresh checkpoint. If the active-block count or fingerprint is not the expected current value, stop and reconcile with the manager. The release must preserve the complete active-block fingerprint, not merely the count. Requests and payment facts may legitimately change during normal operations; reconcile deltas rather than requiring stale fixed totals.

Before migrations, make a fresh full pgBackRest backup to each configured repository separately. The known `repo1` POSIX repository is on the VPS and is not offsite protection:

```sh
sudo -u postgres pgbackrest --stanza=boombala --repo=1 --type=full backup
sudo -u postgres pgbackrest --stanza=boombala --repo=1 info
sudo -u postgres pgbackrest --stanza=boombala --repo=1 verify
```

Only if a second repository is actually configured and healthy, repeat with `--repo=2`. Do not claim independent disaster recovery from repo1. Run the already-validated isolated restore verifier against this fresh backup; require PostgreSQL startup, table/migration/checksum parity, RLS and booking-constraint checks to PASS. If the verifier or restore target is unavailable, stop before migration. No Production restore or replacement is part of this release.

## 3. Prove migrations 017→022 on the isolated restored copy

The migration runner applies the pending files in lexical order. For this RC, prove this exact sequence on the isolated restored copy:

1. `017_sheets_live_sync.sql` — adds shared occupancy and sync metadata, retaining reservation IDs and payment facts.
2. `018_birthday_crm_v2.sql` — adds the V4.2 catalog and booking-card history; it does not rewrite historical payment facts or retire legacy packages.
3. `019_lead_preferred_start_time.sql` — adds nullable `preferred_start_time` and an intake overload while retaining the old signature.
4. `020_lead_follow_up.sql` — adds follow-up fields to existing requests; current IDs/statuses remain intact.
5. `021_booking_whole_hour_starts.sql` — validates whole-hour starts for new reservation inserts only. It does not rewrite existing off-hour reservations; legacy intervals remain visible and continue to occupy their rooms.
6. `022_sheets_apps_script_webhook.sql` — adds webhook request/nonce audit storage. It does not publish/enable the endpoint, change nginx, or install a timer.

On a disposable restored clone only, run the same release scripts with the clone's owner connection. Never point these commands at Production during this proof:

```sh
cd /opt/boombala/platform
# Load the isolated clone's credentials from a root-only environment file; do not echo or cat it.
set -a; . /etc/boombala/migration-drill.env; set +a
npm run db:migrate
BB_API_PASSWORD="$DRILL_API_PASSWORD" BB_ADMIN_PASSWORD="$DRILL_ADMIN_PASSWORD" npm run db:roles
npm run preflight
npm run verify:roles
npm run backup:check
```

Require the clone to report migrations 001–022 with matching checksums, `preflight: OK`, role verification PASS, all three V4.2 IDs (`happy-party`, `star-party`, `boom-bala-party`) with approved prices, and unchanged active reservation/block IDs, ownership mappings, and payment-fact aggregate. Check existing non-whole-hour reservations remain present and continue to occupy their original intervals. Repeat the sync handover regression on the clone. Destroy only the isolated clone using the verifier's guaranteed cleanup. Do not run `catalog:retire-legacy` or activate Sheets writes; retain old package IDs and all CRM-owned reservations.

## 4. Production rollout order (after a separate GO)

The live site is already configured for `LEAD_PIPELINE=strict`; confirm that fact and the absence of `DATABASE_URL` / `TELEGRAM_*` in the site environment without printing values. Confirm `PLATFORM_URL` targets the loopback API and the site/API intake-token fingerprints match, without displaying tokens. Confirm `PLATFORM_PROFILE=kz-production`, `LEAD_PIPELINE=strict`, and `TELEGRAM_NOTIFY_LEVEL=minimal`.

0. **Vercel Preview gate:** build the exact integration PR SHA as Preview for the connected `boombala` and `boombala-platform` projects. Confirm each READY deployment's Git SHA equals the reviewed RC and run the CRM browser smoke through the Preview bridge. Recent PR checks were `Ignored` by the Vercel build-ignore step; a cancelled/ignored check is not a build. Do not promote Preview or merge into the configured Production branch as a substitute for this gate. Confirm the project's Production Branch and auto-deploy behavior in Vercel before any merge; if unavailable, keep merge blocked.
1. Re-run the aggregate baseline and fresh-backup/restore gates above immediately before the window. Verify the Sheets timer is absent/disabled and the webhook/apply flags are disabled.
2. Install the verified artifact under a new immutable `/opt/boombala/releases/<full-sha>/` directory. Verify its archive SHA and `RELEASE.json`; prepare writable `.next/cache` directories for the service users. Do not change either active symlink yet.
3. Apply pending migrations in order 017, 018, 019, 020, 021, 022 using the tested owner environment. The migration runner applies pending files in order: `npm run db:migrate`.
4. Immediately refresh app-role grants because migrations can replace function ACLs:

   ```sh
   BB_API_PASSWORD="$BB_API_PASSWORD" BB_ADMIN_PASSWORD="$BB_ADMIN_PASSWORD" npm run db:roles
   npm run preflight
   npm run verify:roles
   ```

   Run this from the protected migration environment; do not put secret values on a command line or in shell history. `preflight:final` is intentionally not used here because legacy package retirement is not part of this release.
5. Switch `/opt/boombala/platform` atomically to the verified release and restart only `bb-api.service` and `bb-admin.service`; keep the existing outbox worker running unchanged. The Sheets webhook remains fail-closed and nginx does not proxy it. Check bridge health and safe logs.
6. Promote/deploy the exact reviewed Platform Preview to the intended Production target only after the separate GO. If Production is connected to GitHub auto-deploy, follow the verified project Production Branch behavior; do not merge first and discover the deploy policy afterward. Keep rollback to the previous Production deployment immediately available.
7. If the approved RC includes the strict public site change, switch `/opt/boombala/site` atomically to the same verified release and restart only `bb-site.service`. No nginx, DNS, PostgreSQL listener, firewall or WireGuard changes are part of this release.
8. Run local bridge/site health and external smoke checks. Check `/`, `/birthdays`, `/consent`, `/rules`, `/personal-data-consent`, `/privacy`, and `/menu`; confirm the short consent UI and independent legal links. Keep `SHEETS_WEBHOOK_ENABLED=0`, `SHEETS_SYNC_ENABLED=0`; do not install/enable a timer.
9. Run the synthetic strict end-to-end scenario described below only after owner GO. It creates one clearly marked synthetic request in Production, so it is excluded from this pre-GO preparation. Preserve its audit record and remove only that tracked synthetic record using the approved cleanup path after verification.

## 5. Strict intake acceptance checks

Use an approved isolated PostgreSQL and test Telegram responder for pre-release verification. The RC E2E already passed with `star-party`, exact `preferredStartTime=15:00`, `slot_id=NULL`, persisted request visible through the CRM queue/card, one idempotent request/outbox item after retry, and validation refusal for `15:30`. The outbox worker was executed; its Telegram HTTP endpoint was a local responder, not Telegram Bot API or a manager chat.

On the approved Production window, a real delivery check still requires a synthetic request through the public strict form, followed by confirmation that:

- exactly one request and one outbox notification were created;
- the request retains the submitted preferred start time and is visible in `/requests`;
- the Telegram message contains only the request number, date and package, and no name, phone, or other customer details;
- the worker marks that outbox event sent;
- replaying the same idempotency key does not create another request or notification;
- an invalid package/time fails validation without writing a request or notification.

Never send a real client's details as a test. Do not run a bulk retry of `dead` notifications as part of this release.

## 6. Rollback

Before switching, record the exact old site/platform symlink targets and retain the prior release directory. If API/admin/site smoke fails:

1. Roll back the Vercel Production deployment to the recorded previous deployment if the CRM frontend was promoted; do not point users to a Preview URL.
2. Point only `/opt/boombala/site` and `/opt/boombala/platform` back to their recorded old release targets and restart only the services actually switched (`bb-site`, `bb-api`, `bb-admin`).
3. Keep webhook/apply flags off and the Sheets timer disabled. Confirm the prior release serves traffic, strict intake follows its tested compatible path, and active reservation/block fingerprints, payment facts, lead counts, and Sheets mappings match the post-migration checkpoint.
4. Do not reverse migrations 017–022, edit historical legal records, alter bookings/payment facts, or re-enable Sheets sync during rollback. Migrations are additive; 019 retains the legacy intake overload. Never restore over Production as an automatic rollback.
5. If DB preflight or role checks fail after migration, leave the old compatible code active, stop traffic changes, capture only safe error codes, and prepare a database-specific recovery plan.

## 7. Public privacy page — factual corrections pending owner/legal approval

Read-only browser review found the live `/privacy` page still labeled 24.10.2026 and says public forms are checked before being enabled. That conflicts with the live QR form. The live consent says birthday-request contacts stay in CRM and the active `kz-production` Telegram notice contains request number/date/package without name or phone. It also describes local encrypted pgBackRest on the same VPS and says independent external backup is unconfirmed. The consent page showed CRM edition 2; the rules page showed edition 2 and complete V1.3 RU/KK. The privacy wording should be reconciled before public release; no legal text was changed or published in this RC.

Proposed factual wording for owner/legal review (not approved for publication):

**RU**

> QR-регистрация и заявки на дни рождения принимаются публичными формами сайта. Контактные данные заявок сохраняются в Production CRM; рабочая база PostgreSQL размещена на VPS в Казахстане. Для заявки на день рождения CRM формирует служебное уведомление Telegram с номером заявки, датой и пакетом; имя и телефон в текст уведомления не включаются. Данные QR-регистрации в это уведомление не отправляются.
>
> Настроенный pgBackRest использует локальный зашифрованный репозиторий на том же VPS. Независимое внешнее резервное хранилище для Production не подтверждено; локальная копия не защищает от потери VPS.

**KK**

> QR-тіркеу мен туған күнге өтінімдер сайттың ашық нысандары арқылы қабылданады. Өтінімдердің байланыс деректері Production CRM жүйесінде сақталады; жұмыс PostgreSQL базасы Қазақстандағы VPS серверінде орналасқан. Туған күн өтінімі бойынша CRM өтінім нөмірі, күн және пакет көрсетілген қызметтік Telegram хабарламасын қалыптастырады; хабарлама мәтініне аты-жөні мен телефон нөмірі енгізілмейді. QR-тіркеу деректері бұл хабарламаға жіберілмейді.
>
> Бапталған pgBackRest сол VPS-тағы жергілікті шифрланған репозиторийді пайдаланады. Production үшін тәуелсіз сыртқы резервтік сақтау расталмаған; жергілікті көшірме VPS жоғалған жағдайда қорғаныс болып саналмайды.

These fragments state only the observed technical setup. The owner/legal reviewer must approve the full RU/KK policy, document version/date, and whether the existing legal text sufficiently describes the purposes and basis for the required adult companion name. This runbook does not declare that legal question resolved.

## Production release state

- **Code/tests:** RC checks PASS locally and in isolated synthetic E2E.
- **Real Telegram Bot API delivery:** not run; requires the separate Production GO and a one-message synthetic check.
- **Public legal blocker:** `/privacy` is stale; full replacement needs owner/legal approval before publication.
- **Production database/counts/24 blocks:** not accessed or changed in this preparation. Take fresh aggregate counts and block fingerprint immediately before any authorized release.
- **Sheets timer:** remains off; this RC does not enable it.
