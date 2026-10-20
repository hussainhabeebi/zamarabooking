import {
  pgTable, text, boolean, integer, decimal, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  regionEnum, currencyEnum, tenantPlanEnum, tenantStatusEnum, userRoleEnum,
} from "./enums.js";

export const tenants = pgTable("tenants", {
  id:             text("id").primaryKey().default(sql`gen_random_uuid()`),
  name:           text("name").notNull(),
  slug:           text("slug").notNull(),                 // skyjet → skyjet.poomas.com
  customDomain:   text("custom_domain"),                  // flights.skyjetagency.com (CNAME)

  // Self-referential: a tenant can be a reseller with sub-tenants
  parentTenantId: text("parent_tenant_id"),

  status:         tenantStatusEnum("status").notNull().default("ONBOARDING"),
  plan:           tenantPlanEnum("plan").notNull().default("TRIAL"),

  // Region / locale defaults
  region:         regionEnum("region").notNull().default("INDIA"),
  defaultCurrency: currencyEnum("default_currency").notNull().default("INR"),
  defaultLanguage: text("default_language").notNull().default("en"),     // en | ml | ar

  // ── White-label branding ──
  logoUrl:        text("logo_url"),
  faviconUrl:     text("favicon_url"),
  primaryColor:   text("primary_color").notNull().default("#E31E24"),    // POOMAS red
  secondaryColor: text("secondary_color").notNull().default("#F7941D"),  // POOMAS orange
  accentColor:    text("accent_color").notNull().default("#F5C518"),     // POOMAS yellow
  fontFamily:     text("font_family").notNull().default("Inter"),
  companyName:    text("company_name"),
  tagline:        text("tagline"),

  // Controls "Powered by Poomas" badge — shown on TRIAL/STARTER, hidden on PROFESSIONAL+
  showPoweredBy:  boolean("show_powered_by").notNull().default(true),

  // ── Communication / sender identity ──
  supportEmail:    text("support_email"),
  supportPhone:    text("support_phone"),
  supportWhatsApp: text("support_whatsapp"),
  emailSenderName: text("email_sender_name"),    // "SkyJet Bookings"
  whatsappSenderId: text("whatsapp_sender_id"),  // BSP number for outbound WA

  // ── Content ──
  homeBannerConfig: jsonb("home_banner_config"),
  footerConfig:     jsonb("footer_config"),
  homepageRoutes:   jsonb("homepage_routes"),

  // ── Legal ──
  gstNumber:    text("gst_number"),
  vatNumber:    text("vat_number"),
  iataCode:     text("iata_code"),
  address:      text("address"),
  termsUrl:     text("terms_url"),
  privacyUrl:   text("privacy_url"),

  // ── Feature flags ──
  allowB2C:           boolean("allow_b2c").notNull().default(true),
  allowB2B:           boolean("allow_b2b").notNull().default(true),
  allowWhatsApp:      boolean("allow_whatsapp").notNull().default(false),
  allowGroupBooking:  boolean("allow_group_booking").notNull().default(false),
  allowSeatSelection: boolean("allow_seat_selection").notNull().default(false),

  // ── Tenant-level API rate limits (enforced via Durable Objects) ──
  searchRpmLimit:  integer("search_rpm_limit").notNull().default(60),
  bookingRpmLimit: integer("booking_rpm_limit").notNull().default(20),

  // ── Payment gateway config (null = inherit platform defaults) ──
  paymentConfig: jsonb("payment_config"),   // { razorpay: {...}, nomod: {...} }

  // ── Billing (Poomas charges this tenant/reseller) ──
  subscriptionFee:    decimal("subscription_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  perBookingFee:      decimal("per_booking_fee",  { precision: 14, scale: 4 }).notNull().default("0"),
  perBookingFeeType:  text("per_booking_fee_type").notNull().default("PERCENTAGE"),
  billingCycleDay:    integer("billing_cycle_day").notNull().default(1),
  trialEndsAt:        timestamp("trial_ends_at", { withTimezone: true }),
  subscriptionEndsAt: timestamp("subscription_ends_at", { withTimezone: true }),

  // ── Usage metering ── (reset monthly by a scheduled Worker)
  usageCurrentMonth: jsonb("usage_current_month"),   // { searchCalls, bookings, waMessages }
  usageResetAt:      timestamp("usage_reset_at", { withTimezone: true }),

  // ── Setup ──
  onboardingStep:  integer("onboarding_step").notNull().default(0),
  isSetupComplete: boolean("is_setup_complete").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx:         uniqueIndex("tenants_slug_idx").on(t.slug),
  customDomainIdx: uniqueIndex("tenants_custom_domain_idx").on(t.customDomain),
}));

export const tenantApiKeys = pgTable("tenant_api_keys", {
  id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:     text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  name:         text("name").notNull(),
  keyHash:      text("key_hash").notNull(),    // argon2 hash — never stored in plain text
  keyPrefix:    text("key_prefix").notNull(),  // first 8 chars shown in UI ("pmsk_abc1...")
  scopes:       text("scopes").array().notNull().default(sql`'{}'::text[]`),

  isActive:     boolean("is_active").notNull().default(true),
  lastUsedAt:   timestamp("last_used_at", { withTimezone: true }),
  expiresAt:    timestamp("expires_at", { withTimezone: true }),

  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt:    timestamp("revoked_at", { withTimezone: true }),
  revokedById:  text("revoked_by_id"),
}, (t) => ({
  keyHashIdx: uniqueIndex("tenant_api_keys_hash_idx").on(t.keyHash),
}));

export const announcements = pgTable("announcements", {
  id:         text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:   text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  title:      text("title").notNull(),
  content:    text("content").notNull(),
  type:       text("type").notNull().default("INFO"),     // INFO | WARNING | SUCCESS | ALERT
  targetRole: userRoleEnum("target_role"),                // null = all roles
  isActive:   boolean("is_active").notNull().default(true),

  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt:  timestamp("expires_at", { withTimezone: true }),
});

export const subscriptionInvoices = pgTable("subscription_invoices", {
  id:          text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:    text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd:   timestamp("period_end",   { withTimezone: true }).notNull(),

  subscriptionFee: decimal("subscription_fee", { precision: 14, scale: 2 }).notNull(),
  transactionFees: decimal("transaction_fees", { precision: 14, scale: 2 }).notNull(),
  totalAmount:     decimal("total_amount",     { precision: 14, scale: 2 }).notNull(),
  currency:        currencyEnum("currency").notNull(),

  status:     text("status").notNull().default("DRAFT"),  // DRAFT|SENT|PAID|OVERDUE
  paidAt:     timestamp("paid_at",      { withTimezone: true }),
  paymentRef: text("payment_ref"),
  lineItems:  jsonb("line_items").notNull(),

  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookConfigs = pgTable("webhook_configs", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  name:      text("name").notNull(),
  url:       text("url").notNull(),
  secret:    text("secret"),     // Used to sign payloads (HMAC-SHA256)
  events:    text("events").array().notNull(),
  isActive:  boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
