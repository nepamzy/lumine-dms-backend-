const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  listHandler,
  getOneHandler,
  createHandler,
  updateHandler,
  addBatchHandler,
  expiringHandler,
} = require("./product.controller");

// Public catalog browsing (customers don't need to be logged in to view)
router.get("/", listHandler);
router.get("/expiring", authenticate, authorize("admin"), expiringHandler);
router.get("/:id", getOneHandler);

// Admin-only catalog management
router.post("/", authenticate, authorize("admin"), createHandler);
router.patch("/:id", authenticate, authorize("admin"), updateHandler);
router.post("/:id/batches", authenticate, authorize("admin"), addBatchHandler);

module.exports = router;
