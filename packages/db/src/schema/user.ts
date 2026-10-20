import {
  pgTable, text, boolean, timestamp, uniqueIndex, jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { userRoleEnum, currencyEnum } from "./enums.js";

export const users = pgTable("users", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  email:        text("email"),
  phone:        text("phone"),
  name:         text("name"),
  passwordHash: text("password_hash"),
  socialProvider: text("social_provider"),
  socialSubject: text("social_subject"),
  role:         userRoleEnum("role").notNull().default("CUSTOMER"),
  isActive:     boolean("is_active").notNull().default(true),

  // Staff linked to an agent account
  agentId:      text("agent_id"),   // FK to agents.id — set after agents table created

  // Admin panel staff (role STAFF): sections they may open, e.g. ["bookings", "support"].
  adminPermissions: jsonb("admin_permissions").$type<string[]>().notNull().default([]),

  // Auth
  emailVerified:    boolean("email_verified").notNull().default(false),
  phoneVerified:    boolean("phone_verified").notNull().default(false),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  twoFactorSecret:  text("two_factor_secret"),

  // Preferences
  preferredCurrency: currencyEnum("preferred_currency"),
  preferredLanguage: text("preferred_language"),
  whatsappOptIn:     boolean("whatsapp_opt_in").notNull().default(false),

  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt:   timestamp("created_at",    { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at",    { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("users_tenant_email_idx").on(t.tenantId, t.email),
  phoneIdx: uniqueIndex("users_tenant_phone_idx").on(t.tenantId, t.phone),
  socialIdx: uniqueIndex("users_tenant_social_idx").on(t.tenantId, t.socialProvider, t.socialSubject),
}));

export const socialAuthChallenges = pgTable("social_auth_challenges", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  nonce: text("nonce").notNull(),
  proofHash: text("proof_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const userSessions = pgTable("user_sessions", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:    text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  token:     text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex("user_sessions_token_idx").on(t.token),
}));

export const savedPassengers = pgTable("saved_passengers", {
  id:     text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  firstName:       text("first_name").notNull(),
  lastName:        text("last_name").notNull(),
  dob:             timestamp("dob", { withTimezone: true }),
  gender:          text("gender"),
  nationality:     text("nationality"),
  passportNumber:  text("passport_number"),
  passportExpiry:  timestamp("passport_expiry", { withTimezone: true }),
  passportCountry: text("passport_country"),

  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
