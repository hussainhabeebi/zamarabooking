import {
  pgTable, text, decimal, timestamp, jsonb, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { agents } from "./agent.js";
import { users } from "./user.js";
import { bookings } from "./booking.js";
import {
  currencyEnum, paymentGatewayEnum, paymentStatusEnum, walletTxTypeEnum,
} from "./enums.js";

export const payments = pgTable("payments", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  bookingId: text("booking_id").notNull().references(() => bookings.id),

  gateway:          paymentGatewayEnum("gateway").notNull(),
  gatewayOrderId:   text("gateway_order_id"),
  gatewayPaymentId: text("gateway_payment_id"),

  amount:          decimal("amount",   { precision: 14, scale: 2 }).notNull(),
  currency:        currencyEnum("currency").notNull(),
  status:          paymentStatusEnum("status").notNull().default("PENDING"),
  paymentMethod:   text("payment_method"),      // card | upi | netbanking | wallet
  gatewayResponse: jsonb("gateway_response"),   // Raw webhook payload for reconciliation

  refundedAmount:    decimal("refunded_amount",    { precision: 14, scale: 2 }),
  refundInitiatedAt: timestamp("refund_initiated_at", { withTimezone: true }),
  refundCompletedAt: timestamp("refund_completed_at", { withTimezone: true }),
  refundGatewayRef:  text("refund_gateway_ref"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gatewayPaymentIdx: uniqueIndex("payments_gateway_payment_id_idx").on(t.gatewayPaymentId),
}));

export const walletAccounts = pgTable("wallet_accounts", {
  id:       text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  agentId:  text("agent_id").references(() => agents.id),
  userId:   text("user_id").references(() => users.id, { onDelete: "cascade" }),  // customer wallet

  currency:        currencyEnum("currency").notNull(),
  balance:         decimal("balance",      { precision: 14, scale: 2 }).notNull().default("0"),
  creditLimit:     decimal("credit_limit", { precision: 14, scale: 2 }).notNull().default("0"),
  alertThreshold:  decimal("alert_threshold", { precision: 14, scale: 2 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: uniqueIndex("wallet_accounts_agent_id_idx").on(t.agentId),
  userIdx:  uniqueIndex("wallet_accounts_user_id_idx").on(t.userId),
}));

// Customer-to-customer balance sharing: the amount leaves the creator's wallet
// when the code is created and lands in the redeemer's wallet on redemption.
export const walletCoupons = pgTable("wallet_coupons", {
  id:              text("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId:        text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  amount:          decimal("amount", { precision: 14, scale: 2 }).notNull(),
  currency:        currencyEnum("currency").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  walletAccountId: text("wallet_account_id").notNull().references(() => walletAccounts.id),
  status:          text("status").notNull().default("ACTIVE"),  // ACTIVE | REDEEMED | CANCELLED | EXPIRED
  redeemedByUserId: text("redeemed_by_user_id").references(() => users.id),
  redeemedAt:      timestamp("redeemed_at", { withTimezone: true }),
  expiresAt:       timestamp("expires_at",  { withTimezone: true }).notNull(),
  createdAt:       timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx:    uniqueIndex("wallet_coupons_tenant_code_idx").on(t.tenantId, t.code),
}));

export const walletTransactions = pgTable("wallet_transactions", {
  id:              text("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAccountId: text("wallet_account_id").notNull().references(() => walletAccounts.id),

  type:          walletTxTypeEnum("type").notNull(),
  amount:        decimal("amount",        { precision: 14, scale: 2 }).notNull(),
  balanceBefore: decimal("balance_before",{ precision: 14, scale: 2 }).notNull(),
  balanceAfter:  decimal("balance_after", { precision: 14, scale: 2 }).notNull(),

  bookingId:    text("booking_id"),
  paymentId:    text("payment_id"),    // Gateway payment ref for topups
  note:         text("note"),
  performedById: text("performed_by_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const commissions = pgTable("commissions", {
  id:        text("id").primaryKey().default(sql`gen_random_uuid()`),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  agentId:   text("agent_id").notNull().references(() => agents.id),

  baseAmount:   decimal("base_amount",    { precision: 14, scale: 2 }).notNull(),
  ratePercent:  decimal("rate_percent",   { precision: 8,  scale: 4 }).notNull(),
  amount:       decimal("amount",         { precision: 14, scale: 2 }).notNull(),
  currency:     currencyEnum("currency").notNull(),

  paidAt:  timestamp("paid_at",  { withTimezone: true }),
  paidVia: text("paid_via"),   // WALLET | BANK_TRANSFER

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bookingIdx: uniqueIndex("commissions_booking_id_idx").on(t.bookingId),
}));
