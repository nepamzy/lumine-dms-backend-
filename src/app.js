const Sentry = require("@sentry/node");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./modules/auth/auth.routes");
const productRoutes = require("./modules/products/product.routes");
const orderRoutes = require("./modules/orders/order.routes");
const paymentRoutes = require("./modules/payments/payment.routes");
const deliveryRoutes = require("./modules/deliveries/delivery.routes");
const reportRoutes = require("./modules/reports/report.routes");
const notificationRoutes = require("./modules/notifications/notification.routes");
const distributorRoutes = require("./modules/distributors/distributor.routes");
const customerRoutes = require("./modules/customers/customer.routes");
const contactRoutes = require("./modules/contact/contact.routes");
const mapRoutes = require("./modules/map/map.routes");
const { webhookHandler } = require("./modules/payments/payment.controller");
const { errorHandler, notFound } = require("./middleware/error.middleware");

const app = express();
app.set("trust proxy", 1);

app.use(helmet());

// Always allows the configured production/deployed frontend (CLIENT_URL)
// plus localhost:5173 (the frontend's Vite dev server) so local dev testing
// works against this same backend/database without needing to flip CORS
// back and forth.
const allowedOrigins = [process.env.CLIENT_URL || "http://localhost:3000", "http://localhost:5173"];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// IMPORTANT: the Paystack webhook needs the raw request body to verify the
// signature, so it must be mounted with express.raw() BEFORE express.json()
// runs globally. Any route registered after express.json() below would
// receive an already-parsed (and therefore signature-unverifiable) body.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  webhookHandler
);

app.use(express.json());
app.use(cookieParser());

// Basic rate limiting on auth routes to slow down credential-stuffing attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many attempts. Try again later." },
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin/distributors", distributorRoutes);
app.use("/api/admin/customers", customerRoutes);
app.use("/api/admin/map", mapRoutes);
app.use("/api/contact", contactRoutes);

app.use(notFound);

// Reports uncaught errors to Sentry before our own error middleware formats
// the response — must come after routes/notFound, before errorHandler.
Sentry.setupExpressErrorHandler(app);

app.use(errorHandler);

module.exports = app;
