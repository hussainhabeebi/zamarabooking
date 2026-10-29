-- REVIEW ONLY. OUTSIDE the migration runner. No execution is authorized by this PR.
-- Requires a backup, an additive-schema review and separate owner migration approval.
ALTER TYPE payment_gateway ADD VALUE IF NOT EXISTS 'PHONEPE';
CREATE TABLE phonepe_orders (
  merchant_order_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  booking_id text NOT NULL REFERENCES bookings(id),
  payment_id text NOT NULL REFERENCES payments(id),
  environment text NOT NULL,
  account_key text NOT NULL,
  amount_minor integer NOT NULL,
  refund_reserved_minor integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'INITIATED',
  provider_order_id text,
  transaction_id text,
  checkout_url text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phonepe_order_environment_check CHECK (environment IN ('sandbox','production')),
  CONSTRAINT phonepe_order_state_check CHECK (state IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')),
  CONSTRAINT phonepe_order_amount_check CHECK (amount_minor >= 100 AND refund_reserved_minor >= 0 AND refund_reserved_minor <= amount_minor)
);
CREATE UNIQUE INDEX phonepe_order_booking_idx ON phonepe_orders(tenant_id, booking_id);
CREATE UNIQUE INDEX phonepe_order_payment_idx ON phonepe_orders(payment_id);
CREATE UNIQUE INDEX phonepe_order_tenant_ref_idx ON phonepe_orders(tenant_id, merchant_order_id);
CREATE TABLE phonepe_refunds (
  merchant_refund_id text PRIMARY KEY,
  merchant_order_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id),
  amount_minor integer NOT NULL,
  state text NOT NULL DEFAULT 'INITIATED',
  provider_refund_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phonepe_refund_amount_check CHECK (amount_minor >= 100),
  CONSTRAINT phonepe_refund_state_check CHECK (state IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')),
  CONSTRAINT phonepe_refund_order_tenant_fk FOREIGN KEY(tenant_id, merchant_order_id) REFERENCES phonepe_orders(tenant_id, merchant_order_id)
);
CREATE TABLE payment_checkout_claims (
  tenant_id text NOT NULL REFERENCES tenants(id),
  booking_id text NOT NULL REFERENCES bookings(id),
  gateway text NOT NULL,
  CONSTRAINT payment_checkout_claim_gateway_check CHECK (gateway IN ('PHONEPE','NOMOD','RAZORPAY','WALLET'))
);
CREATE UNIQUE INDEX payment_checkout_claim_booking_idx ON payment_checkout_claims(tenant_id, booking_id);
