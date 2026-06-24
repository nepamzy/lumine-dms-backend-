const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
const deliveryService = require("./delivery.service");

const createHandler = asyncHandler(async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) throw new ApiError(400, "orderId is required");
  const delivery = await deliveryService.createDelivery(orderId);
  res.status(201).json({ success: true, data: delivery });
});

const getOneHandler = asyncHandler(async (req, res) => {
  const delivery = await deliveryService.getDeliveryByOrderId(req.params.orderId);
  res.json({ success: true, data: delivery });
});

const updateGpsHandler = asyncHandler(async (req, res) => {
  const { lat, lng } = req.body;
  const delivery = await deliveryService.updateGpsPosition(
    req.params.orderId,
    req.user.id,
    { lat, lng }
  );
  res.json({ success: true, data: delivery });
});

const markDeliveredHandler = asyncHandler(async (req, res) => {
  const delivery = await deliveryService.markDelivered(req.params.orderId, req.user);
  res.json({ success: true, message: "Delivery marked as completed", data: delivery });
});

const markFailedHandler = asyncHandler(async (req, res) => {
  const delivery = await deliveryService.markFailed(
    req.params.orderId,
    req.user,
    req.body.reason
  );
  res.json({ success: true, message: "Delivery marked as failed", data: delivery });
});

const myRouteHandler = asyncHandler(async (req, res) => {
  const deliveries = await deliveryService.listForDistributor(req.user.id);
  res.json({ success: true, data: deliveries });
});

module.exports = {
  createHandler,
  getOneHandler,
  updateGpsHandler,
  markDeliveredHandler,
  markFailedHandler,
  myRouteHandler,
};
