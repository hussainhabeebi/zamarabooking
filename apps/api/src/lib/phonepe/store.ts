import { and, eq, inArray, sql } from "drizzle-orm";
import {
  payments,
  paymentCheckoutClaims,
  phonepeOrders,
  phonepeRefunds,
} from "@zamrabooking/db/schema";
import type { Db } from "@zamrabooking/db";
import { PhonePeError } from "./client.js";
export type Order = typeof phonepeOrders.$inferSelect;
export type Refund = typeof phonepeRefunds.$inferSelect;
export interface PhonePeStore {
  order(tenant: string, id: string): Promise<Order | null>;
  reserve(order: Order): Promise<{ owner: boolean; order: Order }>;
  checkout(
    id: string,
    result: { orderId: string; paymentUrl: string; expiresAt: number },
  ): Promise<void>;
  unknown(id: string): Promise<void>;
  applyOrder(
    order: Order,
    evidence: { state: string; orderId: string; transactionId?: string },
  ): Promise<void>;
  refund(tenant: string, id: string): Promise<Refund | null>;
  reserveRefund(
    order: Order,
    id: string,
    amount: number,
  ): Promise<{ owner: boolean; refund: Refund }>;
  applyRefund(
    refund: Refund,
    state: string,
    providerId: string | null,
  ): Promise<void>;
}
export class PhonePeDbStore implements PhonePeStore {
  constructor(private db: Db) {}
  async order(tenant: string, id: string) {
    return (
      (
        await this.db
          .select()
          .from(phonepeOrders)
          .where(
            and(
              eq(phonepeOrders.tenantId, tenant),
              eq(phonepeOrders.merchantOrderId, id),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  }
  async reserve(o: Order) {
    const [inserted] = await this.db
      .batch([
        this.db
          .insert(payments)
          .values({
            id: o.paymentId,
            bookingId: o.bookingId,
            gateway: "PHONEPE",
            gatewayOrderId: o.merchantOrderId,
            amount: (o.amountMinor / 100).toFixed(2),
            currency: "INR",
            status: "PENDING",
            gatewayResponse: { supplierConfirmationPending: true },
          })
          .onConflictDoNothing(),
        this.db
          .insert(phonepeOrders)
          .values(o)
          .onConflictDoNothing()
          .returning(),
      ])
      .then(([_, rows]) => [rows]);
    const row = await this.order(o.tenantId, o.merchantOrderId);
    if (!row) throw new PhonePeError("RESERVATION_FAILED");
    return { owner: inserted.length > 0, order: row };
  }
  async checkout(
    id: string,
    r: { orderId: string; paymentUrl: string; expiresAt: number },
  ) {
    await this.db
      .update(phonepeOrders)
      .set({
        providerOrderId: r.orderId,
        checkoutUrl: r.paymentUrl,
        expiresAt: new Date(r.expiresAt),
        state: "PENDING",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(phonepeOrders.merchantOrderId, id),
          inArray(phonepeOrders.state, ["INITIATED", "UNKNOWN", "PENDING"]),
        ),
      );
  }
  async unknown(id: string) {
    await this.db
      .update(phonepeOrders)
      .set({ state: "UNKNOWN", updatedAt: new Date() })
      .where(
        and(
          eq(phonepeOrders.merchantOrderId, id),
          eq(phonepeOrders.state, "INITIATED"),
        ),
      );
  }
  async applyOrder(
    o: Order,
    e: { state: string; orderId: string; transactionId?: string },
  ) {
    const eligible =
      e.state === "COMPLETED"
        ? ["INITIATED", "UNKNOWN", "PENDING", "FAILED", "COMPLETED"]
        : e.state === "FAILED"
          ? ["INITIATED", "UNKNOWN", "PENDING", "FAILED"]
          : ["INITIATED", "UNKNOWN", "PENDING"];
    await this.db.batch([
      this.db
        .update(phonepeOrders)
        .set({
          state: e.state,
          providerOrderId: e.orderId,
          ...(e.transactionId ? { transactionId: e.transactionId } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(phonepeOrders.merchantOrderId, o.merchantOrderId),
            eq(phonepeOrders.tenantId, o.tenantId),
            inArray(phonepeOrders.state, eligible),
          ),
        ),
      this.db
        .update(payments)
        .set({
          status:
            e.state === "COMPLETED"
              ? "SUCCESS"
              : e.state === "FAILED"
                ? "FAILED"
                : "PENDING",
          ...(e.transactionId ? { gatewayPaymentId: e.transactionId } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, o.paymentId),
            inArray(
              payments.status,
              e.state === "COMPLETED" ? ["PENDING", "FAILED"] : ["PENDING"],
            ),
          ),
        ),
    ]);
    // Deliberately no bookings update or PAYMENT_CAPTURED message.
  }
  async refund(tenant: string, id: string) {
    return (
      (
        await this.db
          .select()
          .from(phonepeRefunds)
          .where(
            and(
              eq(phonepeRefunds.tenantId, tenant),
              eq(phonepeRefunds.merchantRefundId, id),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  }
  async reserveRefund(o: Order, id: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > o.amountMinor)
      throw new PhonePeError("INVALID_REFUND_AMOUNT");
    const existing = await this.refund(o.tenantId, id);
    if (existing) return { owner: false, refund: existing };
    let inserted = false;
    try {
      // One PostgreSQL statement: row-serialized bounded reservation + unique refund insert.
      // A duplicate ID exception rolls back the reservation too. Unknown/failed refunds
      // retain their reservation until separate owner review; never risk an over-refund.
      const result = await this.db.execute(sql`WITH reserved AS (
        UPDATE phonepe_orders SET refund_reserved_minor = refund_reserved_minor + ${amount}
        WHERE merchant_order_id = ${o.merchantOrderId} AND tenant_id = ${o.tenantId}
          AND state = 'COMPLETED' AND refund_reserved_minor <= amount_minor - ${amount}
        RETURNING merchant_order_id, tenant_id
      ) INSERT INTO phonepe_refunds (merchant_refund_id, merchant_order_id, tenant_id, amount_minor, state)
        SELECT ${id}, merchant_order_id, tenant_id, ${amount}, 'INITIATED' FROM reserved RETURNING merchant_refund_id`);
      inserted = result.rows.length > 0;
    } catch {
      const row = await this.refund(o.tenantId, id);
      if (row) return { owner: false, refund: row };
      throw new PhonePeError("REFUND_RESERVATION_FAILED");
    }
    const row = await this.refund(o.tenantId, id);
    if (!row) throw new PhonePeError("REFUND_LIMIT_EXCEEDED");
    return { owner: inserted, refund: row };
  }
  async applyRefund(r: Refund, state: string, providerId: string | null) {
    await this.db.batch([
      // Serialize refund transitions and ledger aggregation on the same order.
      // Each following statement then observes all earlier committed completions.
      this.db.execute(sql`SELECT merchant_order_id FROM phonepe_orders
        WHERE merchant_order_id = ${r.merchantOrderId} AND tenant_id = ${r.tenantId} FOR UPDATE`),
      this.db
        .update(phonepeRefunds)
        .set({
          state,
          ...(providerId ? { providerRefundId: providerId } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(phonepeRefunds.merchantRefundId, r.merchantRefundId),
            eq(phonepeRefunds.tenantId, r.tenantId),
            inArray(
              phonepeRefunds.state,
              state === "COMPLETED"
                ? ["INITIATED", "PENDING", "UNKNOWN", "FAILED", "COMPLETED"]
                : ["INITIATED", "PENDING", "UNKNOWN"],
            ),
          ),
        ),
      this.db.execute(sql`UPDATE payments SET
        refunded_amount = (SELECT COALESCE(SUM(f.amount_minor),0)::numeric / 100 FROM phonepe_refunds f WHERE f.merchant_order_id = ${r.merchantOrderId} AND f.state = 'COMPLETED'),
        status = CASE WHEN (SELECT COALESCE(SUM(f.amount_minor),0) FROM phonepe_refunds f WHERE f.merchant_order_id = ${r.merchantOrderId} AND f.state = 'COMPLETED') >= (SELECT amount_minor FROM phonepe_orders WHERE merchant_order_id = ${r.merchantOrderId}) THEN 'REFUNDED'::payment_status ELSE 'PARTIAL_REFUND'::payment_status END,
        refund_completed_at = now(), updated_at = now()
        WHERE id = (SELECT payment_id FROM phonepe_orders WHERE merchant_order_id = ${r.merchantOrderId} AND tenant_id = ${r.tenantId})
        AND EXISTS (SELECT 1 FROM phonepe_refunds WHERE merchant_order_id = ${r.merchantOrderId} AND state = 'COMPLETED')`),
    ]);
  }
}

export async function claimCheckoutGateway(
  db: Db,
  tenantId: string,
  bookingId: string,
  gateway: string,
) {
  await db
    .insert(paymentCheckoutClaims)
    .values({ tenantId, bookingId, gateway })
    .onConflictDoNothing();
  const [claim] = await db
    .select()
    .from(paymentCheckoutClaims)
    .where(
      and(
        eq(paymentCheckoutClaims.tenantId, tenantId),
        eq(paymentCheckoutClaims.bookingId, bookingId),
      ),
    )
    .limit(1);
  if (!claim || claim.gateway !== gateway)
    throw new PhonePeError("CHECKOUT_GATEWAY_ALREADY_RESERVED");
}
