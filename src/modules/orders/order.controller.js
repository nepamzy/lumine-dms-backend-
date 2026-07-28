const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const orderService = require("./order.service");

const createHandler = asyncHandler(async (req, res) => {
  const { items, customerId } = req.body;
  // Sales reps place orders on behalf of a customer (customerId in body);
  // everyone else (a customer buying for themselves, or a true distributor
  // buying for themselves) just buys as req.user.
  const buyerId = req.user.role === "distributor" && customerId ? customerId : req.user.id;
  const placedByUserId = buyerId !== req.user.id ? req.user.id : undefined;
  const order = await orderService.createOrder(buyerId, items, { placedByUserId });
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

const editItemsHandler = asyncHandler(async (req, res) => {
  const { items } = req.body;
  const order = await orderService.editOrderItems(req.params.id, items, req.user);
  res.json({ success: true, data: order });
});

const deleteHandler = asyncHandler(async (req, res) => {
  const result = await orderService.deleteOrder(req.params.id, req.user);
  res.json({ success: true, message: "Order removed", data: result });
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

const logPaymentHandler = asyncHandler(async (req, res) => {
  const { amount, note } = req.body;
  if (!amount) throw new ApiError(400, "amount is required");
  const order = await orderService.logPayment(req.params.id, Number(amount), req.user, note);
  res.json({ success: true, data: order });
});

const confirmTransportHandler = asyncHandler(async (req, res) => {
  const order = await orderService.confirmTransport(req.params.id, req.user);
  res.json({ success: true, data: order });
});

const confirmReceivedHandler = asyncHandler(async (req, res) => {
  const order = await orderService.confirmReceived(req.params.id, req.user, { as: req.body.as });
  res.json({ success: true, data: order });
});

const listExpiringHandler = asyncHandler(async (req, res) => {
  const orders = await orderService.listExpiringOrders(req.user);
  res.json({ success: true, data: orders });
});

module.exports = {
  createHandler,
  listHandler,
  getOneHandler,
  cancelHandler,
  editItemsHandler,
  deleteHandler,
  updateStatusHandler,
  assignDistributorHandler,
  logPaymentHandler,
  confirmTransportHandler,
  confirmReceivedHandler,
  listExpiringHandler,
};
