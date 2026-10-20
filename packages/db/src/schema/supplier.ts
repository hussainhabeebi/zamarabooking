import {
  pgTable, text, boolean, integer, decimal, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { agents } from "./agent.js";
import {
  supplierNameEnum, cabinClassEnum, tripTypeEnum, currencyEnum,
} from "./enums.js";

// Per-tenant supplier credential mapping
// null credentials = inherit platform-level Riya/Tripjack contracts
export const tenantSupplierConfigs = pgTable("tenant_supplier_configs", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  supplier:  supplierNameEnum("supplier").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  priority:  integer("priority").notNull().default(1),  // 1 = highest; failover order

  // Credentials encrypted at rest (AES-256-GCM in the Worker)
  // null = use platform-level credentials (Poomas shared contract)
  credentials: jsonb("credentials"),   // { apiKey, secretKey, baseUrl }

  // Per-tenant overrides
  timeoutMs:  integer("timeout_ms").notNull().default(15000),
  maxRetries: integer("max_retries").notNull().default(2),

  // Usage tracking for cost metering & billing
  callsThisMonth: integer("calls_this_month").notNull().default(0),
  callsLimit:     integer("calls_limit"),  // null = unlimited

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantSupplierIdx: uniqueIndex("tenant_supplier_configs_idx").on(t.tenantId, t.supplier),
}));

// Markup rules — evaluated in priority order for each fare shown
export const markupRules = pgTable("markup_rules", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  // null agentId = tenant-wide default; set = agent-specific override
  agentId:  text("agent_id").references(() => agents.id),

  name:      text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),

  // Match conditions (null = matches all)
  airline:    text("airline"),
  origin:     text("origin"),
  destination: text("destination"),
  cabinClass:  cabinClassEnum("cabin_class"),
  supplier:    supplierNameEnum("supplier"),
  tripType:    tripTypeEnum("trip_type"),

  markupType:  text("markup_type").notNull(),                                   // FLAT | PERCENTAGE
  markupValue: decimal("markup_value", { precision: 14, scale: 4 }).notNull(),

  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo:   timestamp("valid_to",   { withTimezone: true }),
  isActive:  boolean("is_active").notNull().default(true),
  priority:  integer("priority").notNull().default(0),  // Higher = evaluated first

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Promo codes (tenant-scoped)
export const promoCodes = pgTable("promo_codes", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  code:        text("code").notNull(),
  description: text("description"),

  discountType:  text("discount_type").notNull(),   // FLAT | PERCENTAGE
  discountValue: decimal("discount_value", { precision: 14, scale: 4 }).notNull(),
  maxDiscount:   decimal("max_discount",   { precision: 14, scale: 2 }),
  minFareAmount: decimal("min_fare_amount",{ precision: 14, scale: 2 }),

  usageLimit:  integer("usage_limit"),
  usageCount:  integer("usage_count").notNull().default(0),
  perUserLimit: integer("per_user_limit").notNull().default(1),

  // Applicability filters
  applicableOn: text("applicable_on").array().notNull().default(sql`'{}'::text[]`),  // ONEWAY|ROUNDTRIP|MULTICITY
  airlines:     text("airlines").array().notNull().default(sql`'{}'::text[]`),        // empty = all
  routes:       text("routes").array().notNull().default(sql`'{}'::text[]`),          // ["BOM-DXB"]

  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo:   timestamp("valid_to",   { withTimezone: true }).notNull(),
  isActive:  boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantCodeIdx: uniqueIndex("promo_codes_tenant_code_idx").on(t.tenantId, t.code),
}));

// TripJack / supplier API call logs — retained 90 days for error analysis
export const supplierApiLogs = pgTable("supplier_api_logs", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  supplier:   supplierNameEnum("supplier").notNull(),
  endpoint:   text("endpoint").notNull(),           // e.g. /oms/v1/air/book
  httpStatus: integer("http_status"),               // null = no HTTP response (timeout/network)
  level:      text("level").notNull().default("INFO"), // INFO | WARN | ERROR
  requestId:  text("request_id"),                   // correlates to booking

  // Sanitised request (no full names/emails, just structural shape)
  requestSummary: jsonb("request_summary"),         // { fareId, paxCount, origin, destination }
  responseSnippet: text("response_snippet"),         // first 800 chars of raw response
  errorCode:      text("error_code"),
  errorMessage:   text("error_message"),
  durationMs:     integer("duration_ms"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantTimeIdx: index("supplier_api_logs_tenant_time_idx").on(t.tenantId, t.createdAt),
  levelIdx:      index("supplier_api_logs_level_idx").on(t.tenantId, t.level, t.createdAt),
}));

// Leadvyne / WhatsApp bot integration config (per tenant, per environment)
export const leadvyneConfigs = pgTable("leadvyne_configs", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  environment:     text("environment").notNull().default("production"),  // staging | production
  chatwootBaseUrl:  text("chatwoot_base_url"),   // e.g. https://app.chatwoot.com
  chatwootInboxId:  integer("chatwoot_inbox_id"),
  chatwootApiToken: text("chatwoot_api_token"),
  whatsappNumber:   text("whatsapp_number"),

  // tenant_id is derived from whatsappNumber/inboxId — never from client payload
  endpointMappings: jsonb("endpoint_mappings").notNull(),  // { search, fareHold, bookCreate, ... }
  timeoutMs:        integer("timeout_ms").notNull().default(15000),
  retryCount:       integer("retry_count").notNull().default(2),

  // Inbound webhook from booking engine → Leadvyne
  webhookUrl:    text("webhook_url"),
  webhookSecret: text("webhook_secret"),  // HMAC-SHA256 signature key

  // WhatsApp template IDs per notification type
  templateMappings: jsonb("template_mappings"),  // { booking_confirmed: "tmpl_id", ... }

  showSerpDisclaimer: boolean("show_serp_disclaimer").notNull().default(true),
  isActive:           boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantEnvIdx: uniqueIndex("leadvyne_configs_tenant_env_idx").on(t.tenantId, t.environment),
}));

// Raw supplier API exchanges (request + response files in R2) for certification logs.
export const supplierExchanges = pgTable("supplier_exchanges", {
  id:          text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:    text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  bookingId:   text("booking_id"),
  searchId:    text("search_id"),
  requestId:   text("request_id"),
  supplier:    text("supplier").notNull(),
  endpoint:    text("endpoint").notNull(),
  url:         text("url").notNull(),
  httpStatus:  integer("http_status"),
  durationMs:  integer("duration_ms"),
  error:       text("error"),
  requestKey:  text("request_key").notNull(),
  responseKey: text("response_key"),
  startedAt:   timestamp("started_at", { withTimezone: true }).notNull(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
