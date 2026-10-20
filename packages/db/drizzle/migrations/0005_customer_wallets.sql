-- Customer wallets: signup, ₹50 booking bonus, wallet payment, admin credit,
-- and balance sharing through single-use coupons. Idempotent; safe to re-run.

ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'BOOKING_BONUS';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'ADMIN_CREDIT';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'COUPON_DEBIT';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'COUPON_CREDIT';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'COUPON_REFUND';

-- A wallet belongs to either an agent (B2B) or a customer user (B2C).
ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_user_id_idx ON wallet_accounts (user_id);

-- Set once when the booking bonus is paid, so it can never be credited twice.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS wallet_bonus_credited_at timestamptz;

CREATE TABLE IF NOT EXISTS wallet_coupons (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id           text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                text NOT NULL,
  amount              numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency            currency NOT NULL,
  created_by_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_account_id   text NOT NULL REFERENCES wallet_accounts(id),
  status              text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | REDEEMED | CANCELLED | EXPIRED
  redeemed_by_user_id text REFERENCES users(id),
  redeemed_at         timestamptz,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_coupons_tenant_code_idx ON wallet_coupons (tenant_id, code);
CREATE INDEX IF NOT EXISTS wallet_coupons_creator_idx ON wallet_coupons (created_by_user_id, status);

-- At most one wallet payment per booking: the row is inserted before the wallet
-- is debited, so a double-submit cannot charge the wallet twice.
CREATE UNIQUE INDEX IF NOT EXISTS payments_wallet_booking_idx ON payments (booking_id) WHERE gateway = 'WALLET';
