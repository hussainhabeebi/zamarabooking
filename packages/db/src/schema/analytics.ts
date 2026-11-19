// Phase 1 customer search tracking (migration 0015_search_analytics.sql, docs/search-analytics.md).
// No foreign keys on purpose: links to bookings / users / tenants are kept by the code.
import {
  pgTable, text, boolean, integer, smallint, decimal, timestamp, jsonb, date, char, index, uniqueIndex, primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const searchEvents = pgTable("search_events", {
  id:               text("id").primaryKey(),
  tenantId:         text("tenant_id").notNull(),
  dedupeKey:        text("dedupe_key").notNull(),
  visitorHash:      text("visitor_hash"),
  userId:           text("user_id"),
  channel:          text("channel").notNull().default("B2C_WEB"),
  tripType:         text("trip_type").notNull(),
  origin:           char("origin", { length: 3 }).notNull(),
  destination:      char("destination", { length: 3 }).notNull(),
  departureDate:    date("departure_date").notNull(),
  returnDate:       date("return_date"),
  legs:             jsonb("legs"),
  adults:           smallint("adults").notNull(),
  children:         smallint("children").notNull().default(0),
  infants:          smallint("infants").notNull().default(0),
  cabinClass:       text("cabin_class").notNull(),
  fareType:         text("fare_type"),
  currency:         text("currency").notNull(),
  outcome:          text("outcome").notNull(),           // RESULTS | NO_RESULTS | ERROR
  resultCount:      integer("result_count").notNull().default(0),
  lowestFare:       decimal("lowest_fare", { precision: 14, scale: 2 }),
  cacheHit:         boolean("cache_hit").notNull().default(false),
  supplierSearchId: text("supplier_search_id"),
  device:           text("device"),
  country:          char("country", { length: 2 }),
  repeatCount:      integer("repeat_count").notNull().default(1),
  firstSeenAt:      timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:       timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  fareSelectedAt:   timestamp("fare_selected_at", { withTimezone: true }),
  bookingId:        text("booking_id"),
}, (t) => ({
  dedupeUq:      uniqueIndex("search_events_dedupe_uq").on(t.tenantId, t.dedupeKey),
  tenantTimeIdx: index("search_events_tenant_time_idx").on(t.tenantId, t.firstSeenAt),
  sectorIdx:     index("search_events_tenant_sector_idx").on(t.tenantId, t.origin, t.destination, t.firstSeenAt),
  depDateIdx:    index("search_events_tenant_depdate_idx").on(t.tenantId, t.departureDate),
  visitorIdx:    index("search_events_visitor_idx").on(t.tenantId, t.visitorHash, t.firstSeenAt),
  userIdx:       index("search_events_user_idx").on(t.tenantId, t.userId, t.firstSeenAt).where(sql`user_id IS NOT NULL`),
  bookingIdx:    index("search_events_booking_idx").on(t.bookingId).where(sql`booking_id IS NOT NULL`),
}));

export const siteVisits = pgTable("site_visits", {
  tenantId:    text("tenant_id").notNull(),
  day:         date("day").notNull(),
  visitorHash: text("visitor_hash").notNull(),
  userId:      text("user_id"),
  device:      text("device"),
  country:     char("country", { length: 2 }),
  landingPath: text("landing_path"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk:     primaryKey({ columns: [t.tenantId, t.day, t.visitorHash] }),
  dayIdx: index("site_visits_tenant_day_idx").on(t.tenantId, t.day),
}));
