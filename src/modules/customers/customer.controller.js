const asyncHandler = require("../../utils/asyncHandler");
const customerService = require("./customer.service");

const listHandler = asyncHandler(async (req, res) => {
  const customers = await customerService.listCustomers();
  res.json({ success: true, data: customers });
});

// Admin reassigns which distributor a customer is currently linked to.
// Body: { distributorId: "<uuid>" | null }
const reassignDistributorHandler = asyncHandler(async (req, res) => {
  const customer = await customerService.reassignDistributor(req.params.id, req.body.distributorId);
  res.json({ success: true, data: customer });
});

const historyHandler = asyncHandler(async (req, res) => {
  const history = await customerService.getCustomerHistory(req.params.id);
  res.json({ success: true, data: history });
});

const removeHandler = asyncHandler(async (req, res) => {
  await customerService.removeCustomer(req.params.id);
  res.json({ success: true, message: "Removed" });
});

module.exports = { listHandler, reassignDistributorHandler, historyHandler, removeHandler };
