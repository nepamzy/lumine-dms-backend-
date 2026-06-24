const asyncHandler = require("../../utils/asyncHandler");
const reportService = require("./report.service");
const { toCSV } = require("../../utils/csv");

function wantsCSV(req) {
  return req.query.format === "csv";
}

const salesHandler = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const report = await reportService.salesReport({ startDate, endDate });

  if (wantsCSV(req)) {
    const csv = toCSV(report.byProduct);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=sales-by-product.csv");
    return res.send(csv);
  }

  res.json({ success: true, data: report });
});

const inventoryHandler = asyncHandler(async (req, res) => {
  const expiringWithinDays = req.query.days ? parseInt(req.query.days, 10) : 30;
  const report = await reportService.inventoryReport({ expiringWithinDays });

  if (wantsCSV(req)) {
    const csv = toCSV(report.stockByProduct);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=inventory.csv");
    return res.send(csv);
  }

  res.json({ success: true, data: report });
});

const deliveryHandler = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const report = await reportService.deliveryReport({ startDate, endDate });

  if (wantsCSV(req)) {
    const csv = toCSV(report.byDistributor);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=delivery-performance.csv");
    return res.send(csv);
  }

  res.json({ success: true, data: report });
});

module.exports = { salesHandler, inventoryHandler, deliveryHandler };
