-- PhonePe SANDBOX HARNESS tables in Cloudflare D1 (staging `zamra-phonepe-staging`,
-- binding PHONEPE_DB of zamra-phonepe-sandbox). Synthetic bookings only.
-- The PRODUCTION PhonePe ledger is Neon (docs/migrations/phonepe-pg-v2-proposed.sql);
-- never apply this file to a production database.
CREATE TABLE phonepe_orders (
  merchant_order_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  account_key TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 100 AND amount_minor <= 2147483647),
  refund_reserved_minor INTEGER NOT NULL DEFAULT 0,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'INITIATED' CHECK (state IN ('INITIATED', 'UNKNOWN', 'PENDING', 'COMPLETED', 'FAILED')),
  provider_order_id TEXT,
  transaction_id TEXT,
  checkout_url TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (refund_reserved_minor >= 0 AND refund_reserved_minor <= amount_minor),
  CHECK (refunded_minor >= 0 AND refunded_minor <= refund_reserved_minor),
  UNIQUE (tenant_id, booking_id),
  UNIQUE (tenant_id, merchant_order_id)
);
CREATE TABLE phonepe_refunds (
  merchant_refund_id TEXT PRIMARY KEY,
  merchant_order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 100),
  state TEXT NOT NULL DEFAULT 'INITIATED' CHECK (state IN ('INITIATED', 'UNKNOWN', 'PENDING', 'COMPLETED', 'FAILED')),
  provider_refund_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, merchant_order_id) REFERENCES phonepe_orders (tenant_id, merchant_order_id)
);
CREATE INDEX phonepe_refund_order_idx ON phonepe_refunds (merchant_order_id);
-- One gateway per booking across PhonePe, Nomod, Razorpay and wallets while
-- PHONEPE_SCHEMA_READY=true. Claims are never cleared automatically.
CREATE TABLE payment_checkout_claims (
  tenant_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  gateway TEXT NOT NULL CHECK (gateway IN ('PHONEPE', 'NOMOD', 'RAZORPAY', 'WALLET')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, booking_id)
);
