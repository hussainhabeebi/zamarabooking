import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { PhonePeError } from "./client.js";
import type { Order, OrderState, PhonePeStore, Refund } from "./store.js";

// SANDBOX HARNESS ONLY (src/sandbox-harness.ts): PhonePe orders/refunds/claims for
// synthetic bookings in the staging D1 database. Production uses store-neon.ts.
// D1 runs each batch as one transaction on a single writer: guarded statements
// cannot interleave with another batch.
const date = (v: unknown) => (v == null ? null : new Date(Number(v)));
function toOrder(r: Record<string, unknown>): Order {
  return {
    merchantOrderId: String(r.merchant_order_id),
    tenantId: String(r.tenant_id),
    bookingId: String(r.booking_id),
    paymentId: `PP_${String(r.merchant_order_id)}`, // no Neon payments row in the sandbox
    environment: r.environment as Order["environment"],
    accountKey: String(r.account_key),
    amountMinor: Number(r.amount_minor),
    refundReservedMinor: Number(r.refund_reserved_minor),
    refundedMinor: Number(r.refunded_minor),
    state: r.state as OrderState,
    providerOrderId: (r.provider_order_id as string | null) ?? null,
    transactionId: (r.transaction_id as string | null) ?? null,
    checkoutUrl: (r.checkout_url as string | null) ?? null,
    expiresAt: date(r.expires_at),
    updatedAt: date(r.updated_at)!,
  };
}
function toRefund(r: Record<string, unknown>): Refund {
  return {
    merchantRefundId: String(r.merchant_refund_id),
    merchantOrderId: String(r.merchant_order_id),
    tenantId: String(r.tenant_id),
    amountMinor: Number(r.amount_minor),
    state: r.state as OrderState,
    providerRefundId: (r.provider_refund_id as string | null) ?? null,
    updatedAt: date(r.updated_at)!,
  };
}
const list = (states: string[]) => states.map((s) => `'${s}'`).join(",");

export class PhonePeD1Store implements PhonePeStore {
  constructor(private db: D1Database) {}
  async order(tenant: string, id: string) {
    const r = await this.db
      .prepare("SELECT * FROM phonepe_orders WHERE tenant_id = ?1 AND merchant_order_id = ?2")
      .bind(tenant, id)
      .first<Record<string, unknown>>();
    return r ? toOrder(r) : null;
  }
  async bookingOrder(tenant: string, bookingId: string) {
    const r = await this.db
      .prepare("SELECT * FROM phonepe_orders WHERE tenant_id = ?1 AND booking_id = ?2")
      .bind(tenant, bookingId)
      .first<Record<string, unknown>>();
    return r ? toOrder(r) : null;
  }
  async recentOrders(tenant: string, limit = 50) {
    const { results } = await this.db
      .prepare("SELECT * FROM phonepe_orders WHERE tenant_id = ?1 ORDER BY updated_at DESC LIMIT ?2")
      .bind(tenant, limit)
      .all<Record<string, unknown>>();
    return results.map(toOrder);
  }
  async reserve(o: Order) {
    // A booking has at most one order (UNIQUE tenant/booking); only the inserter
    // may call PhonePe. Everyone else reads the stored row.
    const now = Date.now();
    const { results } = await this.db
      .prepare(
        `INSERT OR IGNORE INTO phonepe_orders (merchant_order_id, tenant_id, booking_id, environment,
          account_key, amount_minor, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'INITIATED', ?7, ?7) RETURNING merchant_order_id`,
      )
      .bind(o.merchantOrderId, o.tenantId, o.bookingId, o.environment, o.accountKey, o.amountMinor, now)
      .all();
    const row = await this.order(o.tenantId, o.merchantOrderId);
    if (!row) throw new PhonePeError("RESERVATION_FAILED");
    return { owner: results.length > 0, order: row };
  }
  async checkout(id: string, r: { orderId: string; paymentUrl: string; expiresAt: number }) {
    await this.db
      .prepare(
        `UPDATE phonepe_orders SET provider_order_id = ?2, checkout_url = ?3, expires_at = ?4,
          state = 'PENDING', updated_at = ?5
         WHERE merchant_order_id = ?1 AND state IN ('INITIATED','UNKNOWN','PENDING')`,
      )
      .bind(id, r.orderId, r.paymentUrl, r.expiresAt, Date.now())
      .run();
  }
  async unknown(id: string) {
    await this.db
      .prepare("UPDATE phonepe_orders SET state = 'UNKNOWN', updated_at = ?2 WHERE merchant_order_id = ?1 AND state = 'INITIATED'")
      .bind(id, Date.now())
      .run();
  }
  async applyOrder(o: Order, e: { state: string; orderId: string; transactionId?: string }) {
    // Monotonic: late PENDING/FAILED evidence can never downgrade COMPLETED funds.
    const eligible =
      e.state === "COMPLETED"
        ? ["INITIATED", "UNKNOWN", "PENDING", "FAILED", "COMPLETED"]
        : e.state === "FAILED"
          ? ["INITIATED", "UNKNOWN", "PENDING", "FAILED"]
          : ["INITIATED", "UNKNOWN", "PENDING"];
    await this.db
      .prepare(
        `UPDATE phonepe_orders SET state = ?3, provider_order_id = ?4,
          transaction_id = COALESCE(?5, transaction_id), updated_at = ?6
         WHERE merchant_order_id = ?1 AND tenant_id = ?2 AND state IN (${list(eligible)})`,
      )
      .bind(o.merchantOrderId, o.tenantId, e.state, e.orderId, e.transactionId ?? null, Date.now())
      .run();
    // Deliberately no Neon booking update, supplier operation or PAYMENT_CAPTURED message.
  }
  async refund(tenant: string, id: string) {
    const r = await this.db
      .prepare("SELECT * FROM phonepe_refunds WHERE tenant_id = ?1 AND merchant_refund_id = ?2")
      .bind(tenant, id)
      .first<Record<string, unknown>>();
    return r ? toRefund(r) : null;
  }
  async reserveRefund(o: Order, id: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > o.amountMinor)
      throw new PhonePeError("INVALID_REFUND_AMOUNT");
    const existing = await this.refund(o.tenantId, id);
    if (existing) return { owner: false, refund: existing };
    const now = Date.now();
    let inserted = false;
    try {
      // One transaction: insert only while the bounded reservation fits, then add
      // exactly the inserted amount. A duplicate refund ID aborts both statements.
      // Unknown/failed refunds retain their reservation pending owner review.
      const [insert] = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO phonepe_refunds (merchant_refund_id, merchant_order_id, tenant_id, amount_minor,
              state, created_at, updated_at)
             SELECT ?1, merchant_order_id, tenant_id, ?4, 'INITIATED', ?5, ?5 FROM phonepe_orders
             WHERE merchant_order_id = ?2 AND tenant_id = ?3 AND state = 'COMPLETED'
               AND refund_reserved_minor <= amount_minor - ?4`,
          )
          .bind(id, o.merchantOrderId, o.tenantId, amount, now),
        this.db
          .prepare(
            `UPDATE phonepe_orders SET refund_reserved_minor = refund_reserved_minor + ?4, updated_at = ?5
             WHERE merchant_order_id = ?2 AND tenant_id = ?3 AND EXISTS (
               SELECT 1 FROM phonepe_refunds WHERE merchant_refund_id = ?1)`,
          )
          .bind(id, o.merchantOrderId, o.tenantId, amount, now),
      ]);
      inserted = insert.meta.changes > 0;
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
    const eligible =
      state === "COMPLETED"
        ? ["INITIATED", "PENDING", "UNKNOWN", "FAILED", "COMPLETED"]
        : ["INITIATED", "PENDING", "UNKNOWN"];
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE phonepe_refunds SET state = ?3, provider_refund_id = COALESCE(?4, provider_refund_id), updated_at = ?5
           WHERE merchant_refund_id = ?1 AND tenant_id = ?2 AND state IN (${list(eligible)})`,
        )
        .bind(r.merchantRefundId, r.tenantId, state, providerId, now),
      // Recomputed from completed refunds inside the same transaction.
      this.db
        .prepare(
          `UPDATE phonepe_orders SET refunded_minor = (
             SELECT COALESCE(SUM(amount_minor), 0) FROM phonepe_refunds
             WHERE merchant_order_id = ?1 AND tenant_id = ?2 AND state = 'COMPLETED'), updated_at = ?3
           WHERE merchant_order_id = ?1 AND tenant_id = ?2`,
        )
        .bind(r.merchantOrderId, r.tenantId, now),
    ]);
  }
}

export async function claimCheckoutGatewayD1(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  gateway: "PHONEPE" | "NOMOD" | "RAZORPAY" | "WALLET",
) {
  const claim = (await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO payment_checkout_claims (tenant_id, booking_id, gateway, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(tenantId, bookingId, gateway, Date.now()),
    db.prepare("SELECT gateway FROM payment_checkout_claims WHERE tenant_id = ?1 AND booking_id = ?2").bind(tenantId, bookingId),
  ] as D1PreparedStatement[]))[1].results[0] as { gateway?: string } | undefined;
  if (claim?.gateway !== gateway) throw new PhonePeError("CHECKOUT_GATEWAY_ALREADY_RESERVED");
}

/** Sandbox stand-in for a Nomod/Razorpay/wallet checkout: claim only, no provider call. */
export async function claimLegacyGatewayD1(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  gateway: "NOMOD" | "RAZORPAY" | "WALLET",
) {
  const existing = await new PhonePeD1Store(db).bookingOrder(tenantId, bookingId);
  if (existing && existing.state !== "FAILED") throw new PhonePeError("PHONEPE_PAYMENT_EXISTS");
  await claimCheckoutGatewayD1(db, tenantId, bookingId, gateway);
}
