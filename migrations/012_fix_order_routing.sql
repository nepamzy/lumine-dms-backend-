-- Retroactive fix for the order-routing bug: orders were independently
-- re-matched to a sales rep at order-creation time instead of using the
-- customer's actual assigned sales rep, so a customer's orders could land
-- with a DIFFERENT rep than the one actually managing them. This corrects
-- any order that hasn't gone out for transport yet (safe to re-route
-- before it's physically underway) to point at the customer's real
-- assigned sales rep.
UPDATE orders o
SET distributor_id = cp.assigned_distributor_id, updated_at = now()
FROM customer_profiles cp
JOIN users u ON u.id = cp.user_id
WHERE o.customer_id = cp.user_id
  AND u.role = 'customer'
  AND cp.assigned_distributor_id IS NOT NULL
  AND o.transport_confirmed_at IS NULL
  AND o.distributor_id IS DISTINCT FROM cp.assigned_distributor_id;
