const asyncHandler = require("../../utils/asyncHandler");
const productService = require("./product.service");

const listHandler = asyncHandler(async (req, res) => {
  // Admins can see inactive products too via ?includeInactive=true
  const includeInactive = req.query.includeInactive === "true" && req.user?.role === "admin";
  const products = await productService.listProducts({ activeOnly: !includeInactive });
  res.json({ success: true, data: products });
});

const getOneHandler = asyncHandler(async (req, res) => {
  const product = await productService.getProductById(req.params.id);
  res.json({ success: true, data: product });
});

const createHandler = asyncHandler(async (req, res) => {
  const { name, sku, category, unitPrice, imageUrl } = req.body;
  const product = await productService.createProduct({ name, sku, category, unitPrice, imageUrl });
  res.status(201).json({ success: true, data: product });
});

const updateHandler = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct(req.params.id, req.body);
  res.json({ success: true, data: product });
});

const deleteHandler = asyncHandler(async (req, res) => {
  const result = await productService.deleteProduct(req.params.id);
  res.json({ success: true, data: result });
});

const addBatchHandler = asyncHandler(async (req, res) => {
  const { batchNumber, quantity, expiryDate } = req.body;
  const batch = await productService.addBatch(req.params.id, {
    batchNumber,
    quantity,
    expiryDate,
  });
  res.status(201).json({ success: true, data: batch });
});

const updateBatchHandler = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  const batch = await productService.updateBatchQuantity(req.params.id, req.params.batchId, Number(quantity));
  res.json({ success: true, data: batch });
});

const deleteBatchHandler = asyncHandler(async (req, res) => {
  const result = await productService.deleteBatch(req.params.id, req.params.batchId);
  res.json({ success: true, data: result });
});

const expiringHandler = asyncHandler(async (req, res) => {
  const days = req.query.days ? parseInt(req.query.days, 10) : 30;
  const batches = await productService.getExpiringBatches(days);
  res.json({ success: true, data: batches });
});

const getVariantsHandler = asyncHandler(async (req, res) => {
  const variants = await productService.getVariantsWithTiers(req.params.id);
  res.json({ success: true, data: variants });
});

const createVariantHandler = asyncHandler(async (req, res) => {
  const { size, sku, imageUrl, tiers } = req.body;
  const variant = await productService.createVariant(req.params.id, { size, sku, imageUrl, tiers });
  res.status(201).json({ success: true, data: variant });
});
module.exports = {
  listHandler,
  getOneHandler,
  createHandler,
  updateHandler,
  deleteHandler,
  addBatchHandler,
  updateBatchHandler,
  deleteBatchHandler,
  expiringHandler,
  getVariantsHandler,
  createVariantHandler,
};
