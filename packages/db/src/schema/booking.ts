import {
  pgTable, text, boolean, integer, decimal, timestamp, jsonb, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { users } from "./user.js";
import { agents } from "./agent.js";
import {
  bookingStatusEnum, bookingChannelEnum, supplierNameEnum,
  cabinClassEnum, tripTypeEnum, currencyEnum,
} from "./enums.js";

export const bookings = pgTable("bookings", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),

  // Booker identity — one of these is set
  userId:  text("user_id").references(() => users.id),
  agentId: text("agent_id").references(() => agents.id),

  channel: bookingChannelEnum("channel").notNull(),
  status:  bookingStatusEnum("status").notNull().default("SEARCHED"),

  // Itinerary
  tripType:      tripTypeEnum("trip_type").notNull(),
  cabinClass:    cabinClassEnum("cabin_class").notNull().default("ECONOMY"),
  origin:        text("origin").notNull(),         // IATA airport code
  destination:   text("destination").notNull(),
  departureDate: timestamp("departure_date", { withTimezone: true }).notNull(),
  returnDate:    timestamp("return_date",    { withTimezone: true }),

  // Full normalized fare snapshot at time of booking (never changes after CONFIRMED)
  flightData: jsonb("flight_data").notNull(),

  // Passengers
  adultCount:  integer("adult_count").notNull().default(1),
  childCount:  integer("child_count").notNull().default(0),
  infantCount: integer("infant_count").notNull().default(0),

  // Pricing (all in `currency`)
  baseFare:       decimal("base_fare",       { precision: 14, scale: 2 }).notNull(),
  taxes:          decimal("taxes",           { precision: 14, scale: 2 }).notNull(),
  markup:         decimal("markup",          { precision: 14, scale: 2 }).notNull().default("0"),
  convenienceFee: decimal("convenience_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  promoDiscount:  decimal("promo_discount",  { precision: 14, scale: 2 }).notNull().default("0"),
  platformFee:    decimal("platform_fee",    { precision: 14, scale: 2 }).notNull().default("0"),
  totalAmount:    decimal("total_amount",    { precision: 14, scale: 2 }).notNull(),
  currency:       currencyEnum("currency").notNull(),

  // Supplier
  supplier:          supplierNameEnum("supplier").notNull(),
  supplierBookingRef: text("supplier_booking_ref"),
  supplierSessionId:  text("supplier_session_id"),  // For session-based auth flows
  pnr:               text("pnr"),
  ticketNumbers:     text("ticket_numbers").array().notNull().default(sql`'{}'::text[]`),

  // GST (India domestic)
  gstApplicable: boolean("gst_applicable").notNull().default(false),
  gstNumber:     text("gst_number"),
  gstDetails:    jsonb("gst_details"),

  // Add-ons (Phase 2)
  addOns: jsonb("add_ons"),

  // Promo
  promoCodeId: text("promo_code_id"),  // FK to promo_codes

  // B2B hold
  heldUntil: timestamp("held_until", { withTimezone: true }),

  // Group booking reference
  groupRef: text("group_ref"),

  // Contact for confirmation delivery
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),

  // Request metadata
  ipAddress:     text("ip_address"),
  userAgent:     text("user_agent"),
  whatsappPhone: text("whatsapp_phone"),  // Set when channel = WHATSAPP_BOT

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Set once the ₹50 customer booking bonus is credited (guards against double credit)
  walletBonusCreditedAt: timestamp("wallet_bonus_credited_at", { withTimezone: true }),
}, (t) => ({
  tenantStatusIdx: index("bookings_tenant_status_idx").on(t.tenantId, t.status),
  tenantAgentIdx:  index("bookings_tenant_agent_idx").on(t.tenantId, t.agentId),
  pnrIdx:          index("bookings_pnr_idx").on(t.pnr),
  groupRefIdx:     index("bookings_group_ref_idx").on(t.groupRef),
}));

export const bookingPassengers = pgTable("booking_passengers", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  bookingId: text("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),

  passengerType: text("passenger_type").notNull(),  // ADULT | CHILD | INFANT
  title:         text("title"),
  firstName:     text("first_name").notNull(),
  lastName:      text("last_name").notNull(),
  dob:           timestamp("dob", { withTimezone: true }),
  gender:        text("gender"),
  nationality:   text("nationality"),

  passportNumber:  text("passport_number"),
  passportExpiry:  timestamp("passport_expiry", { withTimezone: true }),
  passportCountry: text("passport_country"),

  ticketNumber: text("ticket_number"),
  seatNumber:   text("seat_number"),
  mealCode:     text("meal_code"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cancellationRequests = pgTable("cancellation_requests", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  bookingId: text("booking_id").notNull().references(() => bookings.id),

  reason:          text("reason"),
  requestedById:   text("requested_by_id"),
  status:          text("status").notNull().default("PENDING"),  // PENDING|APPROVED|REJECTED|PROCESSED

  supplierPenalty: decimal("supplier_penalty", { precision: 14, scale: 2 }),
  tenantPenalty:   decimal("tenant_penalty",   { precision: 14, scale: 2 }),
  refundAmount:    decimal("refund_amount",     { precision: 14, scale: 2 }),

  requestedAt:   timestamp("requested_at",   { withTimezone: true }).notNull().defaultNow(),
  processedAt:   timestamp("processed_at",   { withTimezone: true }),
  processedById: text("processed_by_id"),
  notes:         text("notes"),
});

export const reissueRequests = pgTable("reissue_requests", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  bookingId: text("booking_id").notNull().references(() => bookings.id),

  newDepartureDate: timestamp("new_departure_date", { withTimezone: true }),
  newReturnDate:    timestamp("new_return_date",     { withTimezone: true }),
  newOrigin:        text("new_origin"),
  newDestination:   text("new_destination"),
  reason:           text("reason"),
  requestedById:    text("requested_by_id"),
  status:           text("status").notNull().default("PENDING"),

  dateDiffFare:     decimal("date_diff_fare",    { precision: 14, scale: 2 }),
  supplierPenalty:  decimal("supplier_penalty",  { precision: 14, scale: 2 }),
  tenantPenalty:    decimal("tenant_penalty",    { precision: 14, scale: 2 }),
  totalDue:         decimal("total_due",         { precision: 14, scale: 2 }),

  requestedAt:   timestamp("requested_at",   { withTimezone: true }).notNull().defaultNow(),
  processedAt:   timestamp("processed_at",   { withTimezone: true }),
  processedById: text("processed_by_id"),
});

// Post-booking changes requested with the supplier (currently TripJack cancellations).
export const bookingAmendments = pgTable("booking_amendments", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  bookingId: text("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  userId:    text("user_id").references(() => users.id),
  type:      text("type").notNull().default("CANCELLATION"),
  status:    text("status").notNull().default("SUBMITTED"),  // SUBMITTED | PROCESSING | SUCCESS | REJECTED | FAILED
  supplier:  text("supplier").notNull().default("TRIPJACK"),
  supplierAmendmentId: text("supplier_amendment_id"),
  supplierStatus:      text("supplier_status"),
  amountPaid:      decimal("amount_paid",      { precision: 14, scale: 2 }).notNull(),
  supplierCharges: decimal("supplier_charges", { precision: 14, scale: 2 }),
  refundAmount:    decimal("refund_amount",    { precision: 14, scale: 2 }),
  currency:        currencyEnum("currency").notNull(),
  refundMethod:    text("refund_method").notNull().default("WALLET"),  // original payment method: WALLET | NOMOD | MANUAL
  refundStatus:    text("refund_status").notNull().default("PENDING"), // PENDING | PROCESSING | DONE | FAILED | MANUAL_REQUIRED
  refundReference: text("refund_reference"),
  refundError:     text("refund_error"),
  refundedAt:      timestamp("refunded_at", { withTimezone: true }),
  quote:                jsonb("quote"),
  lastSupplierResponse: jsonb("last_supplier_response"),
  adminNote:     text("admin_note"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportRequests = pgTable("support_requests", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId:    text("user_id").references(() => users.id),
  bookingId: text("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  type:      text("type").notNull(),     // DATE_CHANGE | ADD_BAGGAGE | MEAL_SEAT | NAME_CORRECTION | CANCELLATION_HELP | OTHER
  message:   text("message").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  status:    text("status").notNull().default("OPEN"),  // OPEN | IN_PROGRESS | RESOLVED | CLOSED
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
