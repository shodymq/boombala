-- Pricing V4.2 minimal additive catalogue release.
-- Adds only missing target package rows and base/weekday price history rows.
-- Does not modify existing packages/prices, rooms, bookings, leads, payments, blocks, or legal documents.
-- Run with psql -X -v ON_ERROR_STOP=1 against the approved Production connection after backup and owner GO.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('boombala:pricing-v4.2-catalog', 0));
LOCK TABLE bb.packages, bb.price_rules IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  item record;
  package_name text;
  package_active boolean;
  base_amount integer;
  weekday_amount integer;
  has_base boolean;
  has_weekday boolean;
  has_any_price boolean;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('happy-party', 'HAPPY PARTY', 54900, 38430),
      ('star-party', 'STAR PARTY', 79900, 55930),
      ('boom-bala-party', 'BOOM BALA PARTY', 114900, 80430)
    ) AS expected(id, name, base_amount, weekday_amount)
  LOOP
    SELECT p.name, p.is_active INTO package_name, package_active
      FROM bb.packages p WHERE p.id = item.id;

    IF FOUND AND (package_name <> item.name OR package_active IS DISTINCT FROM true) THEN
      RAISE EXCEPTION 'Pricing V4.2 preflight failed for package %: existing name/status differs; no changes applied', item.id;
    END IF;

    SELECT r.amount_kzt INTO base_amount
      FROM bb.price_rules r
      WHERE r.package_id = item.id AND r.rule_type = 'base' AND r.rule_date IS NULL
      ORDER BY r.id DESC LIMIT 1;
    has_base := FOUND;

    SELECT r.amount_kzt INTO weekday_amount
      FROM bb.price_rules r
      WHERE r.package_id = item.id AND r.rule_type = 'weekday' AND r.rule_date IS NULL
      ORDER BY r.id DESC LIMIT 1;
    has_weekday := FOUND;

    SELECT EXISTS (SELECT 1 FROM bb.price_rules r WHERE r.package_id = item.id) INTO has_any_price;

    IF has_base <> has_weekday THEN
      RAISE EXCEPTION 'Pricing V4.2 preflight failed for package %: partial base/weekday history; no changes applied', item.id;
    END IF;
    IF has_base AND (base_amount <> item.base_amount OR weekday_amount <> item.weekday_amount) THEN
      RAISE EXCEPTION 'Pricing V4.2 preflight failed for package %: current price differs; no changes applied', item.id;
    END IF;
    IF NOT has_base AND has_any_price THEN
      RAISE EXCEPTION 'Pricing V4.2 preflight failed for package %: non-base price history exists without base/weekday prices; no changes applied', item.id;
    END IF;
  END LOOP;
END
$preflight$;

DO $add_missing$
DECLARE
  item record;
  next_order integer;
BEGIN
  SELECT COALESCE(MAX(sort_order)::integer, -1) + 1 INTO next_order FROM bb.packages;

  FOR item IN
    SELECT * FROM (VALUES
      ('happy-party', 'HAPPY PARTY', 54900, 38430),
      ('star-party', 'STAR PARTY', 79900, 55930),
      ('boom-bala-party', 'BOOM BALA PARTY', 114900, 80430)
    ) AS expected(id, name, base_amount, weekday_amount)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM bb.packages p WHERE p.id = item.id) THEN
      IF next_order > 32767 THEN
        RAISE EXCEPTION 'Pricing V4.2 preflight failed: package sort order is full; no changes applied';
      END IF;
      INSERT INTO bb.packages (id, name, sort_order) VALUES (item.id, item.name, next_order::smallint);
      next_order := next_order + 1;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM bb.price_rules r
      WHERE r.package_id = item.id AND r.rule_type IN ('base', 'weekday') AND r.rule_date IS NULL
    ) THEN
      INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt, note)
        VALUES (item.id, 'base', item.base_amount, 'Pricing V4.2 approved catalogue');
      INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt, note)
        VALUES (item.id, 'weekday', item.weekday_amount, 'Pricing V4.2 approved catalogue');
    END IF;
  END LOOP;
END
$add_missing$;

COMMIT;

-- Safe, aggregate-only verification output.
SELECT p.id, p.name, p.is_active,
       (SELECT r.amount_kzt FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'base' AND r.rule_date IS NULL ORDER BY r.id DESC LIMIT 1) AS base_kzt,
       (SELECT r.amount_kzt FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'weekday' AND r.rule_date IS NULL ORDER BY r.id DESC LIMIT 1) AS weekday_kzt
FROM bb.packages p
WHERE p.id IN ('happy-party', 'star-party', 'boom-bala-party')
ORDER BY CASE p.id WHEN 'happy-party' THEN 1 WHEN 'star-party' THEN 2 ELSE 3 END;
