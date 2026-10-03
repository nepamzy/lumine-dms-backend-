-- October 2026 distributor bulk-pricing update.
--   - Only distributor tiers change here — pack_price (the flat price
--     Customers and Sales Reps always pay) is untouched.
--   - New tier bands: 5-10 / 11-30 / 31-75 / 76-150 / 151+ packs. Below 5
--     packs, a distributor falls through to no matching tier and pays the
--     same flat pack_price a customer would (order.service.js's
--     buildOrderItemRows already does this automatically whenever no tier
--     matches — no explicit "1-4" tier needed).
--   - Sugar Free priced the same as Full Cream, per existing convention
--     (migration 011 onward).
--   - Upper bounds stored as X.5, matching the existing convention from
--     migration 016, so a half-pack order falls cleanly into one tier.
--   - Same ILIKE matching as migrations 015/016 since production product
--     names are stored as 'fullcream' / 'LITE' / 'SUGAR-FREE'.
--   - Each INSERT's WHERE now also requires the product name to match one
--     of the three known lines, not just pack_price being set — found via
--     local testing: any other priced product would otherwise hit the
--     CASE's implicit ELSE NULL and fail price_tiers' NOT NULL constraint,
--     aborting the whole statement.

DELETE FROM price_tiers;

-- Tier: 5-10 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 5, 10.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 24500
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 22000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 24500
  END
FROM product_variants v JOIN products p ON p.id = v.product_id
 WHERE v.pack_price IS NOT NULL
   AND (p.name ILIKE 'full%cream%' OR p.name ILIKE 'lite' OR p.name ILIKE 'sugar%free%');

-- Tier: 11-30 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 11, 30.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 27000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 23000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 22000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 18000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 27000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 23000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id
 WHERE v.pack_price IS NOT NULL
   AND (p.name ILIKE 'full%cream%' OR p.name ILIKE 'lite' OR p.name ILIKE 'sugar%free%');

-- Tier: 31-75 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 31, 75.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 26000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 22000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 21000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 17000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 26000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 22000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id
 WHERE v.pack_price IS NOT NULL
   AND (p.name ILIKE 'full%cream%' OR p.name ILIKE 'lite' OR p.name ILIKE 'sugar%free%');

-- Tier: 76-150 packs
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 76, 150.5,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 21000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 20000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 16000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 21000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id
 WHERE v.pack_price IS NOT NULL
   AND (p.name ILIKE 'full%cream%' OR p.name ILIKE 'lite' OR p.name ILIKE 'sugar%free%');

-- Tier: 151+ packs (open-ended)
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 151, NULL,
  CASE
    WHEN p.name ILIKE 'full%cream%' AND v.size IN ('1L','50cl') THEN 23000
    WHEN p.name ILIKE 'full%cream%' AND v.size = '35cl' THEN 19000
    WHEN p.name ILIKE 'lite' AND v.size IN ('1L','50cl') THEN 19000
    WHEN p.name ILIKE 'lite' AND v.size = '35cl' THEN 15000
    WHEN p.name ILIKE 'sugar%free%' AND v.size IN ('1L','50cl') THEN 23000
    WHEN p.name ILIKE 'sugar%free%' AND v.size = '35cl' THEN 19000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id
 WHERE v.pack_price IS NOT NULL
   AND (p.name ILIKE 'full%cream%' OR p.name ILIKE 'lite' OR p.name ILIKE 'sugar%free%');
