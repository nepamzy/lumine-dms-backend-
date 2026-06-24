const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const orderService = require("./order.service");

const createHandler = asyncHandler(async (req, res) => {
  const { items } = req.body;
  const order = await orderService.createOrder(req.user.id, items);
  res.status(201).json({ success: true, data: order });
});

const listHandler = asyncHandler(async (req, res) => {
  const orders = await orderService.listOrders(req.user, { status: req.query.status });
  res.json({ success: true, data: orders });
});

const getOneHandler = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById(req.params.id);
  // ownership is enforced for mutations; reads are scoped via listOrders in the UI,
  // but double-check here for direct-link access
  if (req.user.role === "customer" && order.customer_id !== req.user.id) {
    throw new ApiError(403, "You don't have access to this order");
  }
  res.json({ success: true, data: order });
});

const cancelHandler = asyncHandler(async (req, res) => {
  const order = await orderService.cancelOrder(req.params.id, req.user);
  res.json({ success: true, message: "Order cancelled", data: order });
});

const updateStatusHandler = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new ApiError(400, "status is required");
  const order = await orderService.updateStatus(req.params.id, status, req.user);
  res.json({ success: true, data: order });
});

const assignDistributorHandler = asyncHandler(async (req, res) => {
  const { distributorId } = req.body;
  if (!distributorId) throw new ApiError(400, "distributorId is required");
  const order = await orderService.assignDistributor(req.params.id, distributorId);
  res.json({ success: true, data: order });
});

module.exports = {
  createHandler,
  listHandler,
  getOneHandler,
  cancelHandler,
  updateStatusHandler,
  assignDistributorHandler,
};
