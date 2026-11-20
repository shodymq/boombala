-- 017_birthday_packages_v4: schema marker only. Nothing is changed here, on purpose.
-- The Pricing V3 packages and their prices are loaded by `npm run db:seed` (idempotent, from the approved site data), and the old
-- packages are taken off sale by a SEPARATE step after the site has been switched (`npm run catalog:retire-legacy`, see
-- scripts/catalog-release.ts). Deactivating them in a migration would break the site that is still live while it is being replaced.
SELECT 1;
