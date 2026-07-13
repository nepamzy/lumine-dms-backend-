const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const service = require("./map.service");

router.get(
  "/locations",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const locations = await service.listMappableLocations();
    res.json({ success: true, data: locations });
  })
);

module.exports = router;
