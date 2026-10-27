const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
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

// No auth needed — the public key isn't sensitive, and the frontend needs
// it before the user has necessarily done anything past loading the page.
router.get(
  "/push/vapid-public-key",
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: { publicKey: notificationService.VAPID_PUBLIC_KEY || null } });
  })
);

router.post(
  "/push/subscribe",
  authenticate,
  asyncHandler(async (req, res) => {
    await notificationService.subscribeToPush(req.user.id, req.body);
    res.json({ success: true });
  })
);

// Endpoint-keyed, not user-scoped — matches subscribeToPush's upsert.
// Intentionally never called from the logout flow (see the frontend push
// hook) so permission survives logging out and back in.
router.post(
  "/push/unsubscribe",
  authenticate,
  asyncHandler(async (req, res) => {
    await notificationService.unsubscribeFromPush(req.body.endpoint);
    res.json({ success: true });
  })
);

// One-time catch-up button for admin — re-pushes every order/signup alert
// on record to whichever device is logged in and clicks it, never to
// every admin automatically.
router.post(
  "/push/replay-admin-history",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const count = await notificationService.replayAdminPushHistory(req.user.id);
    res.json({ success: true, data: { count } });
  })
);

router.get(
  "/push/status",
  authenticate,
  asyncHandler(async (req, res) => {
    const subscribed = await notificationService.isPushSubscribed(req.user.id, req.query.endpoint);
    res.json({ success: true, data: { subscribed } });
  })
);

module.exports = router;
