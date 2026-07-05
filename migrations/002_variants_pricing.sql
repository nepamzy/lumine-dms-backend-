-- Product variants (sizes) for each flavor
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size VARCHAR(20) NOT NULL,
  sku VARCHAR(50) UNIQUE,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Tiered pricing per variant
CREATE TABLE price_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  min_qty INT NOT NULL,
  max_qty INT,
  price NUMERIC(10,2) NOT NULL
);

CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_tiers_variant ON price_tiers(variant_id);