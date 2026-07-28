-- 2026 pricing correction.
--   - `pack_price` is the flat price paid by Customers, and by Sales Reps
--     placing an order on a customer's behalf (same number — a sales rep
--     order IS a customer order, just entered by someone else). No
--     discount logic applies to either.
--   - `price_tiers` (pack-count ranges) is consulted ONLY for a true
--     Distributor buying for themselves. Ranges below are business tiers
--     1-5 / 6-15 / 16-40 / 41-65 / 66-100+ packs; upper bounds are stored
--     as X.5 so a half-pack order (e.g. 5.5 packs) always falls cleanly
--     into exactly one tier with no gap, matching the existing pattern.
--   - Uses the same ILIKE matching as migration 015 since production
--     product names are stored as 'fullcream' / 'LITE' / 'SUGAR-FREE'.

-- Flat price (Customer + Sales Rep) -----------------------------------

-- Full Cream
UPDATE product_variants v SET pack_price = 33000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 33000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 27000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'full%cream%' AND v.size = '35cl';

-- Lite
UPDATE product_variants v SET pack_price = 28000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 28000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 22000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'lite' AND v.size = '35cl';

-- Sugar Free (same as Full Cream)
UPDATE product_variants v SET pack_price = 33000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 33000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 27000
  FROM products p WHERE v.product_id = p.id AND p.name ILIKE 'sugar%free%' AND v.size = '35cl';

-- Distributor bulk tiers ------------------------------------------------
-- Wipe the old (migration 011/015) tiers before reseeding.
DELETE FROM price_tiers;

-- Tier: 1-5 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 1, 5.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 32000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 26000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 27000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 21000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 32000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 26000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

-- Tier: 6-15 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 6, 15.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 25000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 20000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 25000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

-- Tier: 16-40 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 16, 40.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 27000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 22000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 22500
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 17500
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 27000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 22000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

-- Tier: 41-65 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 41, 65.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 26000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 21000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 21500
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 16500
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 26000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 21000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

-- Tier: 66-100+ packs (open-ended — no ceiling was given above 100)
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 66, NULL,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 20000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 20000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 15000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 20000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;
