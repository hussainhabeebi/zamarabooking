import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.js";
import { bookings } from "./booking.js";
import { payments } from "./payment.js";
export const phonepeOrders = pgTable(
  "phonepe_orders",
  {
    merchantOrderId: text("merchant_order_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    environment: text("environment").notNull(),
    accountKey: text("account_key").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    refundReservedMinor: integer("refund_reserved_minor").notNull().default(0),
    state: text("state").notNull().default("INITIATED"),
    providerOrderId: text("provider_order_id"),
    transactionId: text("transaction_id"),
    checkoutUrl: text("checkout_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    booking: uniqueIndex("phonepe_order_booking_idx").on(
      t.tenantId,
      t.bookingId,
    ),
    payment: uniqueIndex("phonepe_order_payment_idx").on(t.paymentId),
    tenantRef: uniqueIndex("phonepe_order_tenant_ref_idx").on(
      t.tenantId,
      t.merchantOrderId,
    ),
    environment: check(
      "phonepe_order_environment_check",
      sql`${t.environment} IN ('sandbox','production')`,
    ),
    state: check(
      "phonepe_order_state_check",
      sql`${t.state} IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')`,
    ),
    amount: check(
      "phonepe_order_amount_check",
      sql`${t.amountMinor} >= 100 AND ${t.refundReservedMinor} >= 0 AND ${t.refundReservedMinor} <= ${t.amountMinor}`,
    ),
  }),
);
export const phonepeRefunds = pgTable(
  "phonepe_refunds",
  {
    merchantRefundId: text("merchant_refund_id").primaryKey(),
    merchantOrderId: text("merchant_order_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    amountMinor: integer("amount_minor").notNull(),
    state: text("state").notNull().default("INITIATED"),
    providerRefundId: text("provider_refund_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orderTenant: foreignKey({
      name: "phonepe_refund_order_tenant_fk",
      columns: [t.tenantId, t.merchantOrderId],
      foreignColumns: [phonepeOrders.tenantId, phonepeOrders.merchantOrderId],
    }),
    state: check(
      "phonepe_refund_state_check",
      sql`${t.state} IN ('INITIATED','UNKNOWN','PENDING','COMPLETED','FAILED')`,
    ),
    amount: check("phonepe_refund_amount_check", sql`${t.amountMinor} >= 100`),
  }),
);

// Shared gateway choice prevents concurrent checkout requests choosing different providers.
// Existing Nomod/Razorpay behavior is preserved when the PhonePe schema flag is absent.
export const paymentCheckoutClaims = pgTable(
  "payment_checkout_claims",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    gateway: text("gateway").notNull(),
  },
  (t) => ({
    gateway: check(
      "payment_checkout_claim_gateway_check",
      sql`${t.gateway} IN ('PHONEPE','NOMOD','RAZORPAY','WALLET')`,
    ),
    booking: uniqueIndex("payment_checkout_claim_booking_idx").on(
      t.tenantId,
      t.bookingId,
    ),
  }),
);
