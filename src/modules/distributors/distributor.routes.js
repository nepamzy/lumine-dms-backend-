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

router.get(
  "/me/customers",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const customers = await service.listMyCustomers(req.user.id);
    res.json({ success: true, data: customers });
  })
);

router.use(authenticate, authorize("admin"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const distributors = await service.listDistributors({
      status: req.query.status,
      distributorType: req.query.distributorType,
    });
    res.json({ success: true, data: distributors });
  })
);

router.get(
  "/trash",
  asyncHandler(async (req, res) => {
    const trashed = await service.listTrash();
    res.json({ success: true, data: trashed });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await service.removeDistributor(req.params.id);
    res.json({ success: true, message: "Removed" });
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
  "/:id/history",
  asyncHandler(async (req, res) => {
    const history = await service.getDistributorHistory(req.params.id);
    res.json({ success: true, data: history });
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
