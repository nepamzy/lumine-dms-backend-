const express = require("express");
const router = express.Router();
const { authenticate, authorize, authenticateAdminOrCron } = require("../../middleware/auth.middleware");
const {
  createHandler,
  listHandler,
  getOneHandler,
  cancelHandler,
  editItemsHandler,
  shortfallHandler,
  deleteHandler,
  restoreHandler,
  listDeletedHandler,
  updateStatusHandler,
  assignDistributorHandler,
  logPaymentHandler,
  confirmTransportHandler,
  confirmReceivedHandler,
  listExpiringHandler,
  runMonthlyTargetSweepHandler,
} = require("./order.controller");

// Registered before the blanket authenticate below, so an external
// scheduler's X-Cron-Secret header can reach this without a real session.
router.post("/run-monthly-sweep", authenticateAdminOrCron, runMonthlyTargetSweepHandler);

router.use(authenticate); // every order route requires login

// admin included — lets admin place an order on any buyer's behalf (most
// commonly a true distributor's own restock order) via buyerId in the body.
router.post("/", authorize("customer", "distributor", "admin"), createHandler);
router.get("/", listHandler); // scoped by role inside the service
router.get("/expiring", listExpiringHandler); // must come before /:id
router.get("/trash", authorize("admin"), listDeletedHandler); // must come before /:id
router.get("/:id", getOneHandler);
router.post("/:id/cancel", authorize("customer", "distributor", "admin"), cancelHandler);
router.patch("/:id/items", authorize("customer", "distributor", "admin"), editItemsHandler);
// Works regardless of the order's stage (see recordOrderShortfall's own
// comment) — no need to list it alongside the pre-production-only edit
// route above.
router.post("/:id/shortfall", authorize("admin"), shortfallHandler);
router.delete("/:id", authorize("admin"), deleteHandler);
router.patch("/:id/restore", authorize("admin"), restoreHandler);
router.patch("/:id/status", authorize("admin", "distributor"), updateStatusHandler);
router.patch("/:id/assign-distributor", authorize("admin"), assignDistributorHandler);
router.post("/:id/payments", authorize("customer", "distributor", "admin"), logPaymentHandler);
router.patch("/:id/confirm-transport", authorize("admin"), confirmTransportHandler);
router.patch("/:id/confirm-received", authorize("admin", "customer", "distributor"), confirmReceivedHandler);

module.exports = router;
