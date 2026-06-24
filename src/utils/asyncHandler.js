// Wraps async route handlers so errors are passed to Express's error middleware
// instead of needing try/catch in every controller.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
