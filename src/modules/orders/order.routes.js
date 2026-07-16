const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  createHandler,
  listHandler,
  getOneHandler,
  cancelHandler,
  updateStatusHandler,
  assignDistributorHandler,
  logPaymentHandler,
  confirmTransportHandler,
  confirmReceivedHandler,
  listExpiringHandler,
} = require("./order.controller");

router.use(authenticate); // every order route requires login

router.post("/", authorize("customer", "distributor"), createHandler);
router.get("/", listHandler); // scoped by role inside the service
router.get("/expiring", listExpiringHandler); // must come before /:id
router.get("/:id", getOneHandler);
router.post("/:id/cancel", authorize("customer", "admin"), cancelHandler);
router.patch("/:id/status", authorize("admin", "distributor"), updateStatusHandler);
router.patch("/:id/assign-distributor", authorize("admin"), assignDistributorHandler);
router.post("/:id/payments", authorize("customer", "distributor", "admin"), logPaymentHandler);
router.patch("/:id/confirm-transport", authorize("admin"), confirmTransportHandler);
router.patch("/:id/confirm-received", authorize("admin", "customer", "distributor"), confirmReceivedHandler);

module.exports = router;
