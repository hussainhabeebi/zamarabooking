-- Zamra's flight sources besides TripJack: Akbar Travels API, the Poomas
-- partner API, and manual fares kept in Admin or synced from a Google Sheet.
-- Idempotent (applied on every deploy).
ALTER TYPE supplier_name ADD VALUE IF NOT EXISTS 'AKBAR';
ALTER TYPE supplier_name ADD VALUE IF NOT EXISTS 'POOMAS';
ALTER TYPE supplier_name ADD VALUE IF NOT EXISTS 'MANUAL';

CREATE TABLE IF NOT EXISTS manual_fares (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source            text NOT NULL DEFAULT 'ADMIN',   -- ADMIN (typed in Admin) | SHEET (Google Sheet sync)
  travel_date       date NOT NULL,
  origin            text NOT NULL,
  destination       text NOT NULL,
  airline           text NOT NULL,                   -- IATA code, e.g. 6E
  airline_name      text,
  flight_number     text NOT NULL,
  departure_time    text NOT NULL,                   -- HH:MM local
  arrival_time      text NOT NULL,                   -- HH:MM local
  arrival_day_offset integer NOT NULL DEFAULT 0,     -- 1 = arrives the next day
  duration_minutes  integer,                         -- null = worked out from the times
  stops             integer NOT NULL DEFAULT 0,
  cabin_class       text NOT NULL DEFAULT 'ECONOMY',
  adult_fare        numeric(14, 2) NOT NULL,         -- per adult, all taxes included
  child_fare        numeric(14, 2),                  -- null = adult fare
  infant_fare       numeric(14, 2),                  -- null = 0
  currency          text NOT NULL DEFAULT 'INR',
  seats_available   integer NOT NULL DEFAULT 9,
  checked_baggage   text,
  cabin_baggage     text,
  is_refundable     boolean NOT NULL DEFAULT false,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_fares_route_idx ON manual_fares (tenant_id, origin, destination, travel_date);
