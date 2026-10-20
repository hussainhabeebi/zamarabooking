import type { Handler } from "hono";
import { bookings, payments, walletAccounts, walletTransactions } from "@poomas/db/schema";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";

export const razorpayWebhook: Handler<{ Bindings: Env; Variables: Variables }> = async (c) => {
  const rawBody   = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature") ?? "";

  // Verify HMAC-SHA256 signature using Web Crypto (CF Workers native)
  const secret  = new TextEncoder().encode(c.env.RAZORPAY_WEBHOOK_SECRET);
  const data    = new TextEncoder().encode(rawBody);
  const key     = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBytes = Uint8Array.from(signature.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const valid    = await crypto.subtle.verify("HMAC", key, sigBytes, data);

  if (!valid) {
    return c.json({ error: "Invalid signature" }, 400);
  }

  const event = JSON.parse(rawBody) as {
    event: string;
    payload: { payment: { entity: { id: string; order_id: string; status: string; amount: number } } };
  };

  const db = c.get("db");

  if (event.event === "payment.captured") {
    const { id: gatewayPaymentId, order_id, amount } = event.payload.payment.entity;

    await db.update(payments)
      .set({ status: "SUCCESS", gatewayPaymentId, updatedAt: new Date() })
      .where(eq(payments.gatewayOrderId, order_id));

    // Queue booking confirmation job
    await c.env.BOOKING_QUEUE.send({
      type:             "PAYMENT_CAPTURED",
      gatewayPaymentId,
      orderId:          order_id,
      amount:           amount / 100,  // Razorpay amounts are in paise
    });
  }

  if (event.event === "payment.failed") {
    const { order_id } = event.payload.payment.entity;
    await db.update(payments)
      .set({ status: "FAILED", updatedAt: new Date() })
      .where(eq(payments.gatewayOrderId, order_id));
  }

  return c.json({ ok: true });
};
