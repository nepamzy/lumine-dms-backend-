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

// Like authenticate, but doesn't fail when there's no token — used on
// public routes that behave slightly differently for a logged-in admin
// (e.g. product listing showing inactive items too).
function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();

  const token = header.split(" ")[1];
  try {
    req.user = verifyAccessToken(token);
  } catch {
    // Invalid/expired token on a public route — just proceed as anonymous
    // rather than blocking the request.
  }
  next();
}

// Allows either a logged-in admin OR a matching X-Cron-Secret header — the
// second path is for an external scheduler (Render Cron Job, cron-job.org,
// etc.) that can't hold a real admin session. Set CRON_SECRET in the
// backend's env vars and configure the scheduler to send the same value.
function authenticateAdminOrCron(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] === cronSecret) return next();
  return authenticate(req, res, () => authorize("admin")(req, res, next));
}

module.exports = { authenticate, authorize, optionalAuthenticate, authenticateAdminOrCron };
