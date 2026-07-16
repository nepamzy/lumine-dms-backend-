-- Migration 011 assumed product names like 'Full Cream', 'Lite', 'Sugar
-- Free' — but the live catalog actually has them as 'fullcream', 'LITE',
-- 'SUGAR-FREE' (no space, different casing, a hyphen). Nothing matched, so
-- every pack_price stayed null. This re-runs the same pricing seed using
-- normalized name matching (uppercase, spaces/hyphens stripped) so it
-- works regardless of exactly how each name was typed in.

-- Full Cream
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'FULLCREAM' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'FULLCREAM' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'FULLCREAM' AND v.size = '35cl';

-- Lite
UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'LITE' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'LITE' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 25000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'LITE' AND v.size = '35cl';

-- Sugar Free
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'SUGARFREE' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'SUGARFREE' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id
  AND UPPER(REPLACE(REPLACE(p.name, ' ', ''), '-', '')) = 'SUGARFREE' AND v.size = '35cl';

-- Re-seed the distributor discount tiers now that pack_price is actually
-- set — same normalized-name matching, and the same half-pack-safe
-- fractional boundaries as before.
DELETE FROM price_tiers;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 1, 4.5, v.pack_price
FROM product_variants v WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 5, 10.5,
  CASE
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size IN ('1L','50cl') THEN 35000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size = '35cl' THEN 27000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size IN ('1L','50cl') THEN 28000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size = '35cl' THEN 22000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size IN ('1L','50cl') THEN 35000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size = '35cl' THEN 27000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 11, 30.5,
  CASE
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size IN ('1L','50cl') THEN 30000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size = '35cl' THEN 25000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size IN ('1L','50cl') THEN 23000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size = '35cl' THEN 17000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size IN ('1L','50cl') THEN 30000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size = '35cl' THEN 25000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 31, NULL,
  CASE
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size IN ('1L','50cl') THEN 25000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'FULLCREAM' AND v.size = '35cl' THEN 20000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size IN ('1L','50cl') THEN 20000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'LITE' AND v.size = '35cl' THEN 15000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size IN ('1L','50cl') THEN 25000
    WHEN UPPER(REPLACE(REPLACE(p.name,' ',''),'-','')) = 'SUGARFREE' AND v.size = '35cl' THEN 20000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;
