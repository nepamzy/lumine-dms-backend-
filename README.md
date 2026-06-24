# Lumine DMS — Backend

## Setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in real values
```

Create the database and run the migration:

```bash
createdb lumine_dms
psql $DATABASE_URL -f migrations/001_init.sql
```

Run the server:

```bash
npm run dev   # development, auto-restart
npm start     # production
```

Health check: `GET /health`

## What's built so far

- **Auth module** — register (customer/distributor self-signup, distributors require admin approval), login, JWT access + refresh tokens, logout. Admin accounts are created directly in the database, not via public signup.
- **Products module** — catalog CRUD (admin-only for writes, public for browsing), batch/expiry tracking, "expiring soon" report, and **FEFO stock reservation** (`reserveStockFEFO`).
- **Orders module** — order creation reserves stock via FEFO inside a transaction (with row-level locking so concurrent orders can't oversell the same batch), auto-assigns a distributor by matching the customer's state to a territory, enforces valid status transitions (`pending → paid → processing → out_for_delivery → delivered`, or `cancelled` from pending/paid), and releases reserved stock back to inventory on cancellation.
- **Payments module** — Paystack `initialize` for checkout, a signature-verified webhook (`charge.success` → marks payment successful and order paid), and a manual `verify` endpoint for the post-redirect callback flow. The webhook is mounted with `express.raw()` *before* the global JSON parser specifically so the HMAC signature can be checked against the exact raw bytes Paystack sent — mounting it after `express.json()` would silently break verification.
- **Deliveries module** — creates the delivery record once a distributor is assigned, accepts GPS position updates from the distributor's device (auto-flips status from `assigned` to `in_transit` on first ping), `markDelivered` updates both the delivery *and* the order status in one transaction so they can't drift out of sync, `markFailed` for failed drop-offs, and a `my-route` endpoint for a distributor's active-deliveries view. Ownership is enforced — a distributor can only update deliveries assigned to them.
- **Reporting module** (admin-only) — sales report (revenue + order count by state/product/distributor, date-range filterable), inventory report (current stock per product, expiring-soon batches, low-stock alert under 50 units), and delivery performance report (status breakdown, average delivery time, per-distributor delivered/failed counts). Every endpoint supports `?format=csv` for a direct file download, using a small dependency-free CSV writer — only counts revenue from orders that actually reached `paid` or further, so pending/cancelled orders never inflate the numbers.
- **Notifications module** — logs every notification to the database first, then attempts delivery (email via SMTP/nodemailer, SMS via Termii — a Nigerian SMS gateway with local network routing, swappable in `sms.provider.js` alone if you prefer another provider). Hooked into the events that already happen elsewhere: order created → customer email + distributor SMS, payment successful → customer SMS, order moved to out-for-delivery → customer SMS, delivery completed → customer email. **Sends are fire-and-forget** — a failed SMS/email is logged but never rolls back or delays the order/payment/delivery action that triggered it, since a notification failure is not a reason to fail a real transaction.

## Folder structure

```
backend/
├── migrations/001_init.sql       # full schema, run this first
├── src/
│   ├── config/db.js              # PostgreSQL pool
│   ├── middleware/
│   │   ├── auth.middleware.js    # JWT verify + role-based authorize()
│   │   └── error.middleware.js   # centralized error responses
│   ├── utils/
│   │   ├── ApiError.js
│   │   ├── asyncHandler.js
│   │   ├── jwt.js
│   │   └── csv.js
│   ├── modules/
│   │   ├── auth/                 # routes, controller, service
│   │   ├── products/             # routes, controller, service
│   │   ├── orders/                # routes, controller, service
│   │   ├── payments/              # routes, controller, service
│   │   ├── deliveries/            # routes, controller, service
│   │   ├── reports/               # routes, controller, service
│   │   └── notifications/         # routes, service, providers/email, providers/sms
│   ├── app.js
│   └── server.js
```

## Backend status: complete

All planned API modules are built: Auth, Products/Batches, Orders, Payments, Deliveries, Reports, Notifications.

## Next phase

**Frontend** — React/Next.js app consuming this API, applying the navy/gold UI/UX design system and 3D product hero already delivered separately.
