-- PhonePe payment gateway (INR). Idempotent (applied on every deploy).
ALTER TYPE payment_gateway ADD VALUE IF NOT EXISTS 'PHONEPE';
