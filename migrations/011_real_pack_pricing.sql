-- Complete pricing model change:
--   - Pricing is now per PACK, not per bottle.
--   - `pack_price` on product_variants is the flat "Normal Price" — this is
--     the ONLY price customers and sales reps ever see or pay, regardless
--     of how many packs they order. No discount logic applies to them at all.
--   - `price_tiers` (min_qty/max_qty now mean PACK COUNTS, not bottle
--     counts) is consulted ONLY when the buyer is a true distributor —
--     this is where the bulk-discount tiers live.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS pack_price NUMERIC(10,2);

-- Pack counts can be fractional (half-pack orders, e.g. 4.5 packs), so
-- min_qty/max_qty must be NUMERIC, not INTEGER — the original columns
-- (from migration 002) were INT, which would throw a hard error the
-- moment anyone queries with a fractional value.
ALTER TABLE price_tiers ALTER COLUMN min_qty TYPE NUMERIC(10,1);
ALTER TABLE price_tiers ALTER COLUMN max_qty TYPE NUMERIC(10,1);

-- Wipe any old bottle-quantity-based tiers — they used a different unit
-- (bottles, not packs) and would silently miscalculate under the new model.
DELETE FROM price_tiers;

-- Full Cream
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Full Cream' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Full Cream' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Full Cream' AND v.size = '35cl';

-- Lite
UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Lite' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 32000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Lite' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 25000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Lite' AND v.size = '35cl';

-- Sugar Free
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Sugar Free' AND v.size = '1L';
UPDATE product_variants v SET pack_price = 38000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Sugar Free' AND v.size = '50cl';
UPDATE product_variants v SET pack_price = 30000
  FROM products p WHERE v.product_id = p.id AND p.name = 'Sugar Free' AND v.size = '35cl';

-- Distributor-only pack-count discount tiers. Upper bounds are X.5 (not a
-- whole number) so a half-pack order (e.g. 4.5 packs) always falls cleanly
-- into exactly one tier with no gap.
-- Tier bands: 1–4 packs (normal), 5–10, 11–30, 31+.
INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 1, 4.5, v.pack_price
FROM product_variants v WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 5, 10.5,
  CASE
    WHEN p.name = 'Full Cream' AND v.size IN ('1L','50cl') THEN 35000
    WHEN p.name = 'Full Cream' AND v.size = '35cl' THEN 27000
    WHEN p.name = 'Lite' AND v.size IN ('1L','50cl') THEN 28000
    WHEN p.name = 'Lite' AND v.size = '35cl' THEN 22000
    WHEN p.name = 'Sugar Free' AND v.size IN ('1L','50cl') THEN 35000
    WHEN p.name = 'Sugar Free' AND v.size = '35cl' THEN 27000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 11, 30.5,
  CASE
    WHEN p.name = 'Full Cream' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name = 'Full Cream' AND v.size = '35cl' THEN 25000
    WHEN p.name = 'Lite' AND v.size IN ('1L','50cl') THEN 23000
    WHEN p.name = 'Lite' AND v.size = '35cl' THEN 17000
    WHEN p.name = 'Sugar Free' AND v.size IN ('1L','50cl') THEN 30000
    WHEN p.name = 'Sugar Free' AND v.size = '35cl' THEN 25000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;

INSERT INTO price_tiers (variant_id, min_qty, max_qty, price)
SELECT v.id, 31, NULL,
  CASE
    WHEN p.name = 'Full Cream' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name = 'Full Cream' AND v.size = '35cl' THEN 20000
    WHEN p.name = 'Lite' AND v.size IN ('1L','50cl') THEN 20000
    WHEN p.name = 'Lite' AND v.size = '35cl' THEN 15000
    WHEN p.name = 'Sugar Free' AND v.size IN ('1L','50cl') THEN 25000
    WHEN p.name = 'Sugar Free' AND v.size = '35cl' THEN 20000
  END
FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.pack_price IS NOT NULL;
