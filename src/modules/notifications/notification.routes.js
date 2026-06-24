const express = require("express");
const router = express.Router();
const { authenticate } = require("../../middleware/auth.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const notificationService = require("./notification.service");

router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const notifications = await notificationService.listForUser(req.user.id);
    res.json({ success: true, data: notifications });
  })
);

module.exports = router;
