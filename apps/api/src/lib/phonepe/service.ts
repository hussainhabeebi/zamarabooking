import {
  digest,
  minorAmount,
  object,
  orderEvidence,
  PhonePeClient,
  PhonePeError,
} from "./client.js";
import type { Order, PhonePeStore } from "./store.js";
export class PhonePeService {
  constructor(
    private store: PhonePeStore,
    private client: PhonePeClient,
    private tenant: string,
    private environment: "sandbox" | "production",
  ) {}
  async checkout(
    booking: { id: string; totalAmount: string; currency: string },
    redirect: string,
  ) {
    if (booking.currency !== "INR") throw new PhonePeError("INR_REQUIRED");
    const amount = minorAmount(booking.totalAmount);
    if (amount > 2147483647) throw new PhonePeError("AMOUNT_LIMIT");
    const id = `ZP${(await digest(`${this.tenant}\0${booking.id}`)).slice(0, 40)}`;
    const draft: Order = {
      merchantOrderId: id,
      tenantId: this.tenant,
      bookingId: booking.id,
      environment: this.environment,
      accountKey: await this.client.accountKey(),
      amountMinor: amount,
      refundReservedMinor: 0,
      refundedMinor: 0,
      state: "INITIATED",
      providerOrderId: null,
      transactionId: null,
      checkoutUrl: null,
      expiresAt: null,
      updatedAt: new Date(),
    };
    const reservation = await this.store.reserve(draft);
    const row = reservation.order;
    await this.match(row);
    if (row.amountMinor !== amount) throw new PhonePeError("AMOUNT_CHANGED");
    if (!reservation.owner) return this.view(row);
    try {
      await this.store.checkout(
        id,
        await this.client.checkout(id, amount, redirect),
      );
    } catch {
      await this.store.unknown(id);
      throw new PhonePeError("CHECKOUT_OUTCOME_UNKNOWN");
    }
    return this.view((await this.store.order(this.tenant, id))!);
  }
  private view(o: Order) {
    return {
      orderId: o.merchantOrderId,
      state: o.state,
      paymentUrl:
        o.state === "PENDING" &&
        o.expiresAt &&
        o.expiresAt.getTime() > Date.now()
          ? o.checkoutUrl
          : null,
      supplierConfirmed: false,
    };
  }
  private async match(o: Order) {
    if (
      o.tenantId !== this.tenant ||
      o.environment !== this.environment ||
      o.accountKey !== (await this.client.accountKey())
    )
      throw new PhonePeError("ACCOUNT_MISMATCH");
  }
  async reconcile(id: string) {
    const row = await this.store.order(this.tenant, id);
    if (!row) throw new PhonePeError("ORDER_NOT_FOUND");
    await this.match(row);
    const e = orderEvidence(
      await this.client.orderStatus(id),
      row.amountMinor,
      row.providerOrderId,
    );
    await this.store.applyOrder(row, e);
    const persisted = (await this.store.order(this.tenant, id))!;
    return { ...this.view(persisted), paymentState: persisted.state };
  }
  async refund(orderId: string, requestId: string, amount: number) {
    const o = await this.store.order(this.tenant, orderId);
    if (!o) throw new PhonePeError("ORDER_NOT_FOUND");
    await this.match(o);
    if (
      o.state !== "COMPLETED" ||
      !Number.isSafeInteger(amount) ||
      amount < 100 ||
      amount > o.amountMinor
    )
      throw new PhonePeError("INVALID_REFUND");
    const id = `ZR${(await digest(`${this.tenant}\0${requestId}`)).slice(0, 40)}`;
    const r = await this.store.reserveRefund(o, id, amount);
    if (r.refund.merchantOrderId !== orderId || r.refund.amountMinor !== amount)
      throw new PhonePeError("IDEMPOTENCY_CONFLICT");
    if (r.owner) {
      try {
        const d = object(await this.client.refund(id, orderId, amount));
        if (
          d.amount !== amount ||
          d.state !== "PENDING" ||
          typeof d.refundId !== "string" ||
          !d.refundId
        )
          throw new PhonePeError("INVALID_REFUND_RESPONSE");
        await this.store.applyRefund(r.refund, "PENDING", d.refundId);
      } catch {
        await this.store.applyRefund(r.refund, "UNKNOWN", null);
        throw new PhonePeError("REFUND_OUTCOME_UNKNOWN");
      }
    }
    return this.store.refund(this.tenant, id);
  }
  async reconcileRefund(id: string) {
    const r = await this.store.refund(this.tenant, id);
    if (!r) throw new PhonePeError("REFUND_NOT_FOUND");
    const o = await this.store.order(this.tenant, r.merchantOrderId);
    if (!o) throw new PhonePeError("ORDER_NOT_FOUND");
    await this.match(o);
    const d = object(await this.client.refundStatus(id));
    if (
      d.amount !== r.amountMinor ||
      d.originalMerchantOrderId !== o.merchantOrderId ||
      !["PENDING", "COMPLETED", "FAILED"].includes(d.state) ||
      typeof d.refundId !== "string" ||
      !d.refundId ||
      (r.providerRefundId && r.providerRefundId !== d.refundId)
    )
      throw new PhonePeError("REFUND_MISMATCH");
    await this.store.applyRefund(r, d.state, d.refundId);
    return this.store.refund(this.tenant, id);
  }
}
