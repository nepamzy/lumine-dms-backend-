const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { listHandler, reassignDistributorHandler, historyHandler, removeHandler } = require("./customer.controller");

router.get("/", authenticate, authorize("admin"), listHandler);
router.get("/:id/history", authenticate, authorize("admin"), historyHandler);
router.patch("/:id/distributor", authenticate, authorize("admin"), reassignDistributorHandler);
router.delete("/:id", authenticate, authorize("admin"), removeHandler);

module.exports = router;
