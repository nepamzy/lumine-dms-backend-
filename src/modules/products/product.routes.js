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
} = require("./product.controller");

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

module.exports = router;
