const asyncHandler = require("../../utils/asyncHandler");
const customerService = require("./customer.service");

const listHandler = asyncHandler(async (req, res) => {
  const customers = await customerService.listCustomers();
  res.json({ success: true, data: customers });
});

module.exports = { listHandler };