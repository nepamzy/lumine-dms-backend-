const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { listHandler, reassignDistributorHandler } = require("./customer.controller");

router.get("/", authenticate, authorize("admin"), listHandler);
router.patch("/:id/distributor", authenticate, authorize("admin"), reassignDistributorHandler);

module.exports = router;
