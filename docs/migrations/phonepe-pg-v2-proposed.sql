-- REVIEW ONLY. NOT in the automatic migrations folder. Never run via legacy deploy-all.
-- Apply only to a separately approved database after backup and release review.
ALTER TYPE payment_gateway ADD VALUE IF NOT EXISTS 'PHONEPE';
CREATE TABLE phonepe_orders (
  merchant_order_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  booking_id text NOT NULL REFERENCES bookings(id),
  payment_id text NOT NULL REFERENCES payments(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  account_key text NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor >= 100),
  refund_reserved_minor integer NOT NULL DEFAULT 0 CHECK (refund_reserved_minor >= 0 AND refund_reserved_minor <= amount_minor),
  state text NOT NULL DEFAULT 'INITIATED' CHECK (state IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')),
  provider_order_id text,
  transaction_id text,
  checkout_url text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, booking_id)
);
CREATE TABLE phonepe_refunds (
  merchant_refund_id text PRIMARY KEY,
  merchant_order_id text NOT NULL REFERENCES phonepe_orders(merchant_order_id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  amount_minor integer NOT NULL CHECK (amount_minor >= 100),
  state text NOT NULL DEFAULT 'INITIATED' CHECK (state IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')),
  provider_refund_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_checkout_claims (
  tenant_id text NOT NULL REFERENCES tenants(id),
  booking_id text NOT NULL REFERENCES bookings(id),
  gateway text NOT NULL CHECK (gateway IN ('PHONEPE','NOMOD','RAZORPAY','WALLET')),
  UNIQUE (tenant_id, booking_id)
);
