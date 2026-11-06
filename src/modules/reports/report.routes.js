const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  salesHandler,
  inventoryHandler,
  deliveryHandler,
  repRevenueHandler,
  userTotalsHandler,
  monthlyRevenueHandler,
} = require("./report.controller");

router.use(authenticate, authorize("admin"));

router.get("/sales", salesHandler);
router.get("/inventory", inventoryHandler);
router.get("/deliveries", deliveryHandler);
router.get("/rep-revenue", repRevenueHandler);
router.get("/user-totals", userTotalsHandler);
router.get("/monthly-revenue", monthlyRevenueHandler);

module.exports = router;
