const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const {
  createHandler,
  listHandler,
  getOneHandler,
  cancelHandler,
  updateStatusHandler,
  assignDistributorHandler,
} = require("./order.controller");

router.use(authenticate); // every order route requires login

router.post("/", authorize("customer"), createHandler);
router.get("/", listHandler); // scoped by role inside the service
router.get("/:id", getOneHandler);
router.post("/:id/cancel", authorize("customer", "admin"), cancelHandler);
router.patch("/:id/status", authorize("admin", "distributor"), updateStatusHandler);
router.patch("/:id/assign-distributor", authorize("admin"), assignDistributorHandler);

module.exports = router;
