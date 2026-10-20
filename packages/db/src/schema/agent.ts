import {
  pgTable, text, boolean, decimal, timestamp, uniqueIndex, index, jsonb, date, integer, primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { regionEnum, currencyEnum, agentStatusEnum } from "./enums.js";

export const agents = pgTable("agents", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  businessName: text("business_name").notNull(),
  ownerName:    text("owner_name").notNull(),
  email:        text("email").notNull(),
  phone:        text("phone").notNull(),
  whatsapp:     text("whatsapp"),
  region:       regionEnum("region").notNull(),
  currency:     currencyEnum("currency").notNull(),

  status:   agentStatusEnum("status").notNull().default("PENDING"),
  iataCode: text("iata_code"),
  // FlyPoomas agent number (FPA10001 …), given to every agency; Leadvyne tags traffic with it.
  agentNumber: text("agent_number"),

  // Sub-agent hierarchy within a tenant
  parentAgentId: text("parent_agent_id"),  // self-referential FK

  // Finance
  creditLimit:    decimal("credit_limit",    { precision: 14, scale: 2 }).notNull().default("0"),
  minimumDeposit: decimal("minimum_deposit", { precision: 14, scale: 2 }).notNull().default("0"),

  // Agency portal settings: branding, credit terms, freeze, own selling markup, KYC/GST details.
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),

  approvedAt:    timestamp("approved_at",    { withTimezone: true }),
  approvedById:  text("approved_by_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("agents_tenant_email_idx").on(t.tenantId, t.email),
  statusIdx: index("agents_tenant_status_idx").on(t.tenantId, t.status),
  numberIdx: uniqueIndex("agents_tenant_number_idx").on(t.tenantId, t.agentNumber),
}));

// Daily searches / checkout links per agency (Leadvyne Live Agency analytics).
export const agentActivityDaily = pgTable("agent_activity_daily", {
  agentId:   text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  day:       date("day").notNull(),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  searches:  integer("searches").notNull().default(0),
  checkouts: integer("checkouts").notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.agentId, t.day] }),
  tenantIdx: index("agent_activity_daily_tenant_idx").on(t.tenantId, t.day),
}));

export const agentDocuments = pgTable("agent_documents", {
  id:      text("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),

  docType:  text("doc_type").notNull(),   // KYC_PAN | KYC_AADHAAR | IATA_CERT | TRADE_LICENSE
  fileUrl:  text("file_url").notNull(),   // R2 object URL
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),

  uploadedAt:    timestamp("uploaded_at",    { withTimezone: true }).notNull().defaultNow(),
  verifiedAt:    timestamp("verified_at",    { withTimezone: true }),
  verifiedById:  text("verified_by_id"),
});

// Agency service requests: deposits, visa, packages, hotels, groups, amendments,
// offline bookings, support tickets and leads from the agency mini-site.
export const agentRequests = pgTable("agent_requests", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:  text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  agentId:   text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  userId:    text("user_id"),
  bookingId: text("booking_id"),
  type:      text("type").notNull(),
  status:    text("status").notNull().default("OPEN"),
  title:     text("title").notNull(),
  details:   jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  attachments: jsonb("attachments").$type<{ key: string; name: string; type: string; size: number }[]>().notNull().default([]),
  amount:    decimal("amount", { precision: 14, scale: 2 }),
  currency:  text("currency"),
  adminNote: text("admin_note"),
  dueAt:     timestamp("due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx:  index("agent_requests_agent_idx").on(t.agentId, t.createdAt),
  statusIdx: index("agent_requests_tenant_status_idx").on(t.tenantId, t.status, t.type, t.createdAt),
}));

export const agentRequestMessages = pgTable("agent_request_messages", {
  id:          text("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId:   text("request_id").notNull().references(() => agentRequests.id, { onDelete: "cascade" }),
  userId:      text("user_id"),
  fromStaff:   boolean("from_staff").notNull().default(false),
  message:     text("message").notNull(),
  attachments: jsonb("attachments").$type<{ key: string; name: string; type: string; size: number }[]>().notNull().default([]),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentQuotes = pgTable("agent_quotes", {
  id:            text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:      text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  agentId:       text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  userId:        text("user_id"),
  token:         text("token").notNull().unique(),
  customerName:  text("customer_name"),
  customerPhone: text("customer_phone"),
  options:       jsonb("options").$type<Record<string, unknown>[]>().notNull().default([]),
  note:          text("note"),
  currency:      text("currency").notNull().default("INR"),
  expiresAt:     timestamp("expires_at", { withTimezone: true }).notNull(),
  viewedAt:      timestamp("viewed_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTravellers = pgTable("agent_travellers", {
  id:             text("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId:        text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  type:           text("type").notNull().default("ADULT"),
  firstName:      text("first_name").notNull(),
  lastName:       text("last_name").notNull(),
  dob:            date("dob"),
  gender:         text("gender"),
  nationality:    text("nationality"),
  passportNumber: text("passport_number"),
  passportExpiry: date("passport_expiry"),
  phone:          text("phone"),
  email:          text("email"),
  groupName:      text("group_name"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
