-- Group fares: published manual fares listed on the website (/group-fares), with seats held
-- atomically at checkout so a fare is never oversold. Additive and idempotent: existing manual
-- fares keep behaving exactly as before (is_group_fare defaults to false).
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS is_group_fare boolean NOT NULL DEFAULT false;
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS is_published  boolean NOT NULL DEFAULT false;
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS title         text;
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS description   text;
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS sale_ends_at  timestamptz;        -- null = on sale until departure
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS min_pax       integer NOT NULL DEFAULT 1;
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS max_pax       integer;            -- null = up to the seats left
ALTER TABLE manual_fares ADD COLUMN IF NOT EXISTS seats_total   integer;            -- seats in the group block (display)

-- One row per booking of a group fare. seats_available on manual_fares already excludes
-- HELD and SOLD seats; RELEASED rows gave theirs back. No foreign keys: the hold is written
-- just before its booking, and a hold outlives a deleted fare as part of the booking record.
CREATE TABLE IF NOT EXISTS manual_fare_seat_holds (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       text NOT NULL,
  manual_fare_id  text NOT NULL,
  booking_id      text NOT NULL UNIQUE,
  seats           integer NOT NULL CHECK (seats > 0),
  status          text NOT NULL DEFAULT 'HELD',     -- HELD | SOLD | RELEASED | OVERSOLD
  expires_at      timestamptz NOT NULL,             -- HELD only: released after this unless paid
  sold_at         timestamptz,
  released_at     timestamptz,
  release_reason  text,                             -- EXPIRED | CANCELLED | BOOKING_NOT_SAVED
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_fare_seat_holds_fare_idx   ON manual_fare_seat_holds (tenant_id, manual_fare_id, status);
CREATE INDEX IF NOT EXISTS manual_fare_seat_holds_status_idx ON manual_fare_seat_holds (status, expires_at);
