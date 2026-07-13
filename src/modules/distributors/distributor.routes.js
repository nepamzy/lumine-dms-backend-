const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const service = require("./distributor.service");

// Distributor-facing: view their own referral code/link + referred customers.
// Must come before the admin-only `router.use` below.
router.get(
  "/me/referral",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const info = await service.getReferralInfo(req.user.id);
    res.json({ success: true, data: info });
  })
);

router.use(authenticate, authorize("admin"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const distributors = await service.listDistributors({ status: req.query.status });
    res.json({ success: true, data: distributors });
  })
);

router.patch(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const distributor = await service.approveDistributor(req.params.id, req.body.territoryId);
    res.json({ success: true, data: distributor });
  })
);

router.patch(
  "/:id/reject",
  asyncHandler(async (req, res) => {
    const distributor = await service.rejectDistributor(req.params.id);
    res.json({ success: true, data: distributor });
  })
);

router.patch(
  "/:id/suspend",
  asyncHandler(async (req, res) => {
    const distributor = await service.suspendDistributor(req.params.id);
    res.json({ success: true, data: distributor });
  })
);

router.get(
  "/territories/all",
  asyncHandler(async (req, res) => {
    const territories = await service.listTerritories();
    res.json({ success: true, data: territories });
  })
);

router.post(
  "/territories",
  asyncHandler(async (req, res) => {
    const { name, state } = req.body;
    const territory = await service.createTerritory({ name, state });
    res.status(201).json({ success: true, data: territory });
  })
);

module.exports = router;
