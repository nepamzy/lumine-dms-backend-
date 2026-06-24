const ApiError = require("../utils/ApiError");

function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      details: err.details || undefined,
    });
  }

  // Unique constraint violation (e.g. duplicate email/SKU)
  if (err.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A record with this value already exists",
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({
    success: false,
    message: "Something went wrong on our end. Please try again.",
  });
}

function notFound(req, res) {
  res.status(404).json({ success: false, message: "Route not found" });
}

module.exports = { errorHandler, notFound };
