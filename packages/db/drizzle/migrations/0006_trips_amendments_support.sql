-- Post-booking: cancellations (TripJack amendments) and customer support requests.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS booking_amendments (
  id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id             text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id            text NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id               text REFERENCES users(id),
  type                  text NOT NULL DEFAULT 'CANCELLATION',
  -- SUBMITTED → PROCESSING → SUCCESS | REJECTED ; FAILED = submit call failed
  status                text NOT NULL DEFAULT 'SUBMITTED',
  supplier              text NOT NULL DEFAULT 'TRIPJACK',
  supplier_amendment_id text,
  supplier_status       text,
  amount_paid           numeric(14, 2) NOT NULL,           -- what the customer paid
  supplier_charges      numeric(14, 2),                    -- airline + supplier cancellation charges
  refund_amount         numeric(14, 2),                    -- what the customer gets back
  currency              currency NOT NULL,
  -- Refund goes back to the original payment method: WALLET | NOMOD | MANUAL
  refund_method         text NOT NULL DEFAULT 'WALLET',
  -- PENDING → PROCESSING → DONE | FAILED (retryable) | MANUAL_REQUIRED (outcome unknown / no automatic route)
  refund_status         text NOT NULL DEFAULT 'PENDING',
  refund_reference      text,
  refund_error          text,
  refunded_at           timestamptz,
  quote                 jsonb,
  last_supplier_response jsonb,
  admin_note            text,
  last_checked_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_amendments_booking_idx ON booking_amendments (booking_id);
CREATE INDEX IF NOT EXISTS booking_amendments_tenant_status_idx ON booking_amendments (tenant_id, status, created_at);
-- Only one live cancellation per booking (double-submit protection).
CREATE UNIQUE INDEX IF NOT EXISTS booking_amendments_one_active_cancel_idx
  ON booking_amendments (booking_id) WHERE type = 'CANCELLATION' AND status IN ('SUBMITTED', 'PROCESSING', 'SUCCESS');

CREATE TABLE IF NOT EXISTS support_requests (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id),
  booking_id  text REFERENCES bookings(id) ON DELETE SET NULL,
  type        text NOT NULL,          -- DATE_CHANGE | ADD_BAGGAGE | MEAL_SEAT | NAME_CORRECTION | CANCELLATION_HELP | OTHER
  message     text NOT NULL,
  contact_email text,
  contact_phone text,
  status      text NOT NULL DEFAULT 'OPEN',   -- OPEN | IN_PROGRESS | RESOLVED | CLOSED
  admin_note  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_requests_tenant_status_idx ON support_requests (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS support_requests_user_idx ON support_requests (user_id, created_at);
