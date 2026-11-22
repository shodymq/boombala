# Pricing V4.2 site-only release

This release updates the public birthday offer pages and the visible package choices in the existing lead form. The request stays on the current `/api/lead` contract (`name`, `phone`, `date`, `children`, `package`, `consent`, `room`, `slot`, plus the existing idempotency and attribution fields). It does not add `preferredStartTime`, change `LEAD_PIPELINE`, alter Telegram routing, or modify Platform, migrations, legal documents, bookings, or payments.

The approved public package source is `src/data/birthday-packages-v4.json` (approved 2026-11-20). The three IDs and prices are `happy-party` 54,900 / 38,430 ₸, `star-party` 79,900 / 55,930 ₸, and `boom-bala-party` 114,900 / 80,430 ₸. RU and KK copy is rendered from that manifest. The existing legacy IDs (`wow-party`, `magic-party`, `boom-party`) remain accepted by the current site API for cached forms and remain unchanged in the Platform source catalogue.

## Catalog operation

Do not run the broad `platform` `db:seed` for this release: it also seeds rooms and writes a general seed audit event. The narrow SQL file `deploy/kz/pricing-v42-catalog-add.sql` only inserts absent V4.2 package rows and their absent base/weekday history rows. It uses a transaction, locks the two catalogue tables, validates all three IDs before writing, refuses partial or conflicting catalogue state, never updates/deletes a row, and is idempotent. It does not touch leads, contacts, rooms, reservations/blocks, payment facts, legal documents, or outbox.

The operation is additive. If the site rollback is needed, restore the previous site release; leave the new catalogue rows in place. The old site continues to submit its legacy IDs. Do not delete or retire packages as part of this release.

## Owner release sequence

This is a prepared procedure, not authorization to execute it. Production steps require a separate owner GO.

1. **Production preflight.** Record current site release SHA and active site symlink; verify the current `/api/lead` configuration and run read-only counts of packages, leads, contacts, active reservations/blocks, and payment facts. Confirm existing V4 IDs are absent or already match exactly. Stop if any target ID has a different name/status/current price or partial price history.
2. **Backup.** Run the approved fresh pgBackRest backup and isolated restore verifier. Confirm both report PASS. The current POSIX pgBackRest repository is on the same VPS, so it is not an offsite backup.
3. **Review catalogue operation.** Review the exact SQL and dry-run it against a restored isolated Production copy. Confirm it proposes only the three package rows and six base/weekday rows (or fewer where already exact), and that legacy package IDs and all business aggregates/checksums match before and after.
4. **Separate owner GO.** Confirm package copy/prices are approved and authorize the catalogue write. Do not infer authorization from approval of the site PR.
5. **Apply catalogue.** Run `psql -X -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f deploy/kz/pricing-v42-catalog-add.sql` from the verified release checkout. Do not use `platform db:seed`. Save only aggregate output and the psql exit status in the release record; never log a connection URL.
6. **Deploy the site artifact.** Verify the retrieved artifact SHA and embedded `RELEASE.json`, unpack to a new release directory, then ensure `site/.next/cache` exists and is owned by `bbsite:bbsite` (the systemd unit binds this exact path into its writable namespace). Atomically switch only `/opt/boombala/site` and restart only `bb-site.service` using the established site deployment procedure. Leave `/opt/boombala/platform` and every Platform service unchanged.
7. **Smoke.** Check HTTP 200 for `/`, `/birthdays`, `/kk/birthdays`, and existing public routes. POST an invalid package to `/api/lead` (expected HTTP 400 and no write). In a browser verify the three names, both prices, RU/KK copy, package selection, and no old offers in the public selector. Do not submit a real Production enquiry as a test.
8. **Rollback if needed.** Atomically restore the recorded previous `/opt/boombala/site` symlink and restart only `bb-site.service`; verify the previous site is healthy. Keep the additive catalogue rows. No database rollback is needed or permitted: the old site still recognizes the old package IDs, and the additive rows are unused by it.

## Pre-release evidence

- `node scripts/test-pricing-v42-catalog.mjs` proves first insert, repeat no-op, exact prices, unchanged legacy catalog/business counts, and fail-closed conflict handling. It requires the isolated local PostgreSQL cluster on `127.0.0.1:54330`, a fresh database migrated through the current Platform migrations, and the legacy-only seed. It refuses any non-local endpoint and reports no client data.
- The intake E2E must run the site in its current strict profile against the current Platform intake API and isolated PostgreSQL, with synthetic contact data and no Telegram credentials. It verifies the RU/KK rendered page names and prices, all three new IDs, all three legacy IDs, duplicate idempotency key, invalid package rejection, lead/outbox counts, and no new payload property or route change. No production request is part of the test.
- The Linux x86_64 site-only artifact is produced by the manual `site-release-artifact.yml` workflow. The workflow does not deploy or promote a domain; it uploads a versioned archive and SHA-256 as a CI artifact.
