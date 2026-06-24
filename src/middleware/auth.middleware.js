const ApiError = require("../utils/ApiError");
const { verifyAccessToken } = require("../utils/jwt");

// Verifies the JWT on protected routes and attaches the decoded user to req.user
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new ApiError(401, "Authentication required"));
  }

  const token = header.split(" ")[1];
  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return next(new ApiError(401, "Invalid or expired token"));
  }
}

// Restricts a route to specific roles, e.g. authorize('admin'), authorize('admin','distributor')
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new ApiError(403, "You don't have permission to do that"));
    }
    next();
  };
}

module.exports = { authenticate, authorize };
