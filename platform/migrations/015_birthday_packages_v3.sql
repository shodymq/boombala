-- 015_birthday_packages_v3: the approved Pricing V3 packages (HAPPY, STAR, BOOM BALA PARTY) replace the packages on sale.
-- Non-destructive: the retired packages are only DEACTIVATED. Their rows, price history, bookings and the CRM's reports stay as they are.
-- The new packages and their regular/weekday prices are loaded by `npm run db:seed` from the public site's approved data (idempotent);
-- the preflight refuses to start until the three new packages are active and priced (see core/preflight.ts).
UPDATE packages SET is_active = false WHERE id IN ('wow-party', 'magic-party', 'boom-party') AND is_active;
