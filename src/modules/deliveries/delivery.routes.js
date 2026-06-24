const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  createHandler,
  getOneHandler,
  updateGpsHandler,
  markDeliveredHandler,
  markFailedHandler,
  myRouteHandler,
} = require("./delivery.controller");

router.use(authenticate);

router.post("/", authorize("admin"), createHandler);
router.get("/my-route", authorize("distributor"), myRouteHandler);
router.get("/:orderId", getOneHandler);
router.patch("/:orderId/gps", authorize("distributor"), updateGpsHandler);
router.patch("/:orderId/delivered", authorize("admin", "distributor"), markDeliveredHandler);
router.patch("/:orderId/failed", authorize("admin", "distributor"), markFailedHandler);

module.exports = router;
