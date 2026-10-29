// Storage contract for PhonePe. Two implementations share it:
//   - store-neon.ts: PRODUCTION ledger. One Neon `payments` row per PhonePe order,
//     written in the same transaction as the PhonePe order/refund rows.
//   - store-d1.ts:   SANDBOX harness only (synthetic bookings in staging D1).
// Production code constructs only the Neon store; nothing is written to both.
export type OrderState = "INITIATED" | "UNKNOWN" | "PENDING" | "COMPLETED" | "FAILED";
export interface Order {
  merchantOrderId: string;
  tenantId: string;
  bookingId: string;
  /** Neon `payments.id` for this order (deterministic: `PP_<merchantOrderId>`). */
  paymentId: string;
  environment: "sandbox" | "production";
  accountKey: string;
  amountMinor: number;
  refundReservedMinor: number;
  /** Completed refunds, in paise (read from the ledger; never written directly). */
  refundedMinor: number;
  state: OrderState;
  providerOrderId: string | null;
  transactionId: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  updatedAt: Date;
}
export interface Refund {
  merchantRefundId: string;
  merchantOrderId: string;
  tenantId: string;
  amountMinor: number;
  state: OrderState;
  providerRefundId: string | null;
  updatedAt: Date;
}
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

/** Ledger status in the vocabulary of Neon `payments.status`. */
export function phonePeLedgerStatus(o: Order) {
  if (o.state === "COMPLETED")
    return o.refundedMinor >= o.amountMinor ? "REFUNDED" : o.refundedMinor > 0 ? "PARTIAL_REFUND" : "SUCCESS";
  return o.state === "FAILED" ? "FAILED" : "PENDING";
}
