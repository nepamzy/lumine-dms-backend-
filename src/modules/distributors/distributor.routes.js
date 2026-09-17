const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../../middleware/auth.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const ApiError = require("../../utils/ApiError");
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

// No-Android-phone provision: a sales rep OR a true distributor fills out
// the same fields a customer would, on the customer's behalf.
router.post(
  "/me/customers/register",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const user = await service.registerCustomerForRep(req.user.id, req.body);
    res.status(201).json({ success: true, data: user });
  })
);

// Distributor-only (enforced inside the service): onboards a new sales rep
// directly, auto-approved. Route-level check just confirms "some kind of
// distributor-table user" — the true-distributor-only rule lives in the
// service, same pattern as registerCustomerForRep above.
router.post(
  "/me/sales-reps/register",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const user = await service.registerSalesRepForDistributor(req.user.id, req.body);
    res.status(201).json({ success: true, data: user });
  })
);

// Payout bank account setup (true-distributor-only, enforced inside the
// service). Three steps: list banks for the picker, resolve an account
// number to its holder name (free, no side effects), then confirm to
// actually create the Paystack subaccount.
router.get(
  "/me/banks",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const banks = await service.listBanks();
    res.json({ success: true, data: banks });
  })
);

router.post(
  "/me/bank/resolve",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const result = await service.resolveBankAccount(req.user.id, req.body);
    res.json({ success: true, data: result });
  })
);

router.post(
  "/me/subaccount",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const result = await service.createSubaccountForDistributor(req.user.id, req.body);
    res.status(201).json({ success: true, data: result });
  })
);

router.get(
  "/me/payout-account",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const status = await service.getPayoutAccountStatus(req.user.id);
    res.json({ success: true, data: status });
  })
);

// Read-only visibility for a true distributor (item 8) — full order/payment
// detail on every customer and sales rep in their hierarchy. True-
// distributor-only, enforced inside the service. No management/approval
// action lives behind any of these — that stays exclusively admin's.
router.get(
  "/me/hierarchy/customers",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const customers = await service.listHierarchyCustomers(req.user.id);
    res.json({ success: true, data: customers });
  })
);

router.get(
  "/me/hierarchy/customers/:customerId",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const history = await service.getHierarchyCustomerHistory(req.user.id, req.params.customerId);
    res.json({ success: true, data: history });
  })
);

router.get(
  "/me/hierarchy/sales-reps",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const reps = await service.listHierarchySalesReps(req.user.id);
    res.json({ success: true, data: reps });
  })
);

router.get(
  "/me/track-record",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const customers = await service.listTrackRecordCustomers(req.user.id);
    res.json({ success: true, data: customers });
  })
);

router.get(
  "/me/track-record/:customerId",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    const history = await service.getCustomerHistoryForRep(req.user.id, req.params.customerId);
    res.json({ success: true, data: history });
  })
);

router.post(
  "/me/track-record/:customerId/ping",
  authenticate,
  authorize("distributor"),
  asyncHandler(async (req, res) => {
    await service.pingCustomer(req.user.id, req.params.customerId, req.body.orderId);
    res.json({ success: true, message: "Reminder sent" });
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

router.patch(
  "/trash/:userId/restore",
  asyncHandler(async (req, res) => {
    const restored = await service.restoreUser(req.params.userId);
    res.json({ success: true, message: "Restored", data: restored });
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
  "/:id/target-overview",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month) throw new ApiError(400, "year and month are required");
    const data = await service.getTargetOverviewForRep(req.params.id, year, month);
    res.json({ success: true, data });
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
