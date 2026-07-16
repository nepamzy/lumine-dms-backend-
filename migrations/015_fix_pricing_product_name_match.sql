-- Migration 011 assumed product names 'Full Cream' / 'Lite' / 'Sugar Free',
-- but production actually has 'fullcream' / 'LITE' / 'SUGAR-FREE' — so
-- every UPDATE in 011 matched zero rows and pack_price/price_tiers stayed
-- empty. This redoes the same seeding using case-insensitive matching so
-- it's safe regardless of exact casing/formatting.
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '35cl';

UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 25000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '35cl';

UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '35cl';

-- Reseed distributor-only tiers the same way — 011's INSERTs found nothing
-- to seed since pack_price was null for every row at the time they ran.
DELETE FROM price_tiers;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 1, 4.5, v.pack_price
FROM product_variants v WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 5, 10.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 35000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 27000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 28000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 22000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 35000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 27000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 11, 30.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 25000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 23000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 17000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 25000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 31, NULL,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 20000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 20000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 15000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 20000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;
