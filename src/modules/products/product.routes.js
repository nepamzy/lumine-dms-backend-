const express = require("express");
const router = express.Router();
const { authenticate, authorize, optionalAuthenticate } = require("../../middleware/auth.middleware");
const {
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
  runDailyBatchHandler,
} = require("./product.controller");

// Allows either a logged-in admin OR a matching X-Cron-Secret header — the
// second path is for an external scheduler (Render Cron Job, cron-job.org,
// etc.) that can't hold a real admin session. Set CRON_SECRET in the
// backend's env vars and configure the scheduler to send the same value.
function authenticateAdminOrCron(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] === cronSecret) return next();
  return authenticate(req, res, () => authorize("admin")(req, res, next));
}

// Public catalog browsing (customers don't need to be logged in to view)
router.get("/", optionalAuthenticate, listHandler);
router.get("/expiring", authenticate, authorize("admin"), expiringHandler);
router.get("/:id", getOneHandler);
router.get("/:id/variants", getVariantsHandler);
router.post("/:id/variants", authenticate, authorize("admin"), createVariantHandler);

// Admin-only catalog management
router.post("/", authenticate, authorize("admin"), createHandler);
router.patch("/:id", authenticate, authorize("admin"), updateHandler);
router.delete("/:id", authenticate, authorize("admin"), deleteHandler);
router.post("/:id/batches", authenticate, authorize("admin"), addBatchHandler);
router.patch("/:id/batches/:batchId", authenticate, authorize("admin"), updateBatchHandler);
router.delete("/:id/batches/:batchId", authenticate, authorize("admin"), deleteBatchHandler);
router.post("/run-daily-batch", authenticateAdminOrCron, runDailyBatchHandler);

module.exports = router;
