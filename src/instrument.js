require("dotenv").config();
const Sentry = require("@sentry/node");

// Must be required before any other module (see server.js) so Sentry can
// instrument express/pg/etc. Silently no-ops if SENTRY_DSN isn't set, so
// local dev works fine without a Sentry account configured.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
});
