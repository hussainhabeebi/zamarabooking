-- Phase 1 — customer search tracking + Admin analytics (docs/search-analytics.md).
--
-- Additive and idempotent: creates two NEW tables and their indexes. It does not alter any
-- existing table, column, index or enum. No foreign keys (as in 0014): a foreign key to
-- bookings / users / tenants would briefly lock those live tables while it is created; the
-- links are kept by the code (lib/search-analytics.ts) instead.
--
-- Rollback (removes analytics data only, needs separate approval):
--   packages/db/drizzle/rollback/0015_search_analytics_down.sql

-- One row per customer search: one visitor, one exact itinerary, one day (India time).
-- Refreshes and repeats of that search the same day only raise repeat_count.
CREATE TABLE IF NOT EXISTS search_events (
  id                 text PRIMARY KEY,                -- derived from dedupe_key (same search → same id)
  tenant_id          text NOT NULL,
  dedupe_key         text NOT NULL,                   -- sha256(visitor | itinerary | India day)
  visitor_hash       text,                            -- HMAC of the visitor cookie; null when the browser opted out
  user_id            text,                            -- signed-in customer, else null
  channel            text NOT NULL DEFAULT 'B2C_WEB',
  trip_type          text NOT NULL,                   -- ONEWAY | ROUNDTRIP | MULTICITY
  origin             char(3) NOT NULL,
  destination        char(3) NOT NULL,
  departure_date     date NOT NULL,
  return_date        date,
  legs               jsonb,                           -- multi-city legs only
  adults             smallint NOT NULL,
  children           smallint NOT NULL DEFAULT 0,
  infants            smallint NOT NULL DEFAULT 0,
  cabin_class        text NOT NULL,
  fare_type          text,                            -- STUDENT | SENIOR_CITIZEN
  currency           text NOT NULL,
  outcome            text NOT NULL,                   -- RESULTS | NO_RESULTS | ERROR
  result_count       integer NOT NULL DEFAULT 0,
  lowest_fare        numeric(14,2),                   -- cheapest per-adult price shown (incl. markup)
  cache_hit          boolean NOT NULL DEFAULT false,
  supplier_search_id text,                            -- links to Admin → API logs
  device             text,                            -- mobile | tablet | desktop
  country            char(2),                         -- from Cloudflare; no IP address is stored
  repeat_count       integer NOT NULL DEFAULT 1,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  fare_selected_at   timestamptz,                     -- booking page opened from this search
  booking_id         text,                            -- first booking created from this search
  CONSTRAINT search_events_dedupe_uq UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS search_events_tenant_time_idx    ON search_events (tenant_id, first_seen_at);
CREATE INDEX IF NOT EXISTS search_events_tenant_sector_idx  ON search_events (tenant_id, origin, destination, first_seen_at);
CREATE INDEX IF NOT EXISTS search_events_tenant_depdate_idx ON search_events (tenant_id, departure_date);
CREATE INDEX IF NOT EXISTS search_events_visitor_idx        ON search_events (tenant_id, visitor_hash, first_seen_at);
CREATE INDEX IF NOT EXISTS search_events_user_idx           ON search_events (tenant_id, user_id, first_seen_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS search_events_booking_idx        ON search_events (booking_id) WHERE booking_id IS NOT NULL;

-- One row per visitor per day (India time), for "visitors today". Written once a day per visitor.
CREATE TABLE IF NOT EXISTS site_visits (
  tenant_id     text NOT NULL,
  day           date NOT NULL,
  visitor_hash  text NOT NULL,
  user_id       text,
  device        text,
  country       char(2),
  landing_path  text,                                 -- path only, never the query string
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, visitor_hash)
);
CREATE INDEX IF NOT EXISTS site_visits_tenant_day_idx ON site_visits (tenant_id, day);
