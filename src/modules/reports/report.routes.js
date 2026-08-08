const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { salesHandler, inventoryHandler, deliveryHandler, repRevenueHandler } = require("./report.controller");

router.use(authenticate, authorize("admin"));

router.get("/sales", salesHandler);
router.get("/inventory", inventoryHandler);
router.get("/deliveries", deliveryHandler);
router.get("/rep-revenue", repRevenueHandler);

module.exports = router;
