const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const { listHandler } = require("./customer.controller");

router.get("/", authenticate, authorize("admin"), listHandler);

module.exports = router;