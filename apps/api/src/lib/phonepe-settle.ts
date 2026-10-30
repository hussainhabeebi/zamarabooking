import type { Db } from "@zamrabooking/db";
import { bookings, payments } from "@zamrabooking/db/schema";
import { and, eq, ne } from "drizzle-orm";
import type { Env } from "../types.js";
import { getPhonePeOrderStatus, getPhonePeToken, phonePeConfigForTenant } from "./phonepe.js";

export type PhonePeSettlement = "SUCCESS" | "FAILED" | "PENDING" | "UNCONFIGURED";

// Asks PhonePe for the order's real state and records it. A COMPLETED order is
// captured exactly once (the conditional update decides which caller wins), then
// handed to the booking queue like every other paid booking.
export async function settlePhonePePayment(
  env: Env, db: Db, tenantId: string,
  payment: { id: string; bookingId: string; gatewayOrderId: string | null; amount: string; status: string },
): Promise<PhonePeSettlement> {
  if (payment.status === "SUCCESS") return "SUCCESS";
  if (!payment.gatewayOrderId) return "PENDING";
  const { config } = await phonePeConfigForTenant(env, tenantId);
  if (!config) return "UNCONFIGURED";

  const token  = await getPhonePeToken(config, env.TENANT_CACHE_KV);
  const status = await getPhonePeOrderStatus(config, token, payment.gatewayOrderId);

  if (status.state === "COMPLETED") {
    const expectedPaise = Math.round(Number(payment.amount) * 100);
    if (status.amountPaise !== undefined && status.amountPaise !== expectedPaise) {
      console.error(`[phonepe] amount mismatch on ${payment.gatewayOrderId}: paid ${status.amountPaise} paise, expected ${expectedPaise}`);
      return "PENDING";
    }
    const gatewayPaymentId = status.transactionId ?? payment.gatewayOrderId;
    const [won] = await db.update(payments)
      .set({ status: "SUCCESS", gatewayPaymentId, gatewayResponse: status.raw as object, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), ne(payments.status, "SUCCESS")))
      .returning({ id: payments.id });
    if (!won) return "SUCCESS";

    await db.update(bookings)
      .set({ status: "PAYMENT_PENDING", updatedAt: new Date() })
      .where(eq(bookings.id, payment.bookingId));
    await env.BOOKING_QUEUE.send({
      type:             "PAYMENT_CAPTURED",
      gatewayPaymentId,
      orderId:          payment.gatewayOrderId,
      amount:           Number(payment.amount),
    });
    console.info(`[phonepe] captured ${payment.gatewayOrderId} txn=${gatewayPaymentId} booking=${payment.bookingId}`);
    return "SUCCESS";
  }

  if (status.state === "FAILED") {
    if (payment.status === "PENDING") {
      await db.update(payments)
        .set({ status: "FAILED", gatewayResponse: status.raw as object, updatedAt: new Date() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, "PENDING")));
    }
    return "FAILED";
  }
  return "PENDING";
}
