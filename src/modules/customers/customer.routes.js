const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { listHandler, reassignDistributorHandler, historyHandler } = require("./customer.controller");

router.get("/", authenticate, authorize("admin"), listHandler);
router.get("/:id/history", authenticate, authorize("admin"), historyHandler);
router.patch("/:id/distributor", authenticate, authorize("admin"), reassignDistributorHandler);

module.exports = router;
