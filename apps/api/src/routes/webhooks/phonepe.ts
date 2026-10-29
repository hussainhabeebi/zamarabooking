import type { PhonePeContext } from "../../lib/phonepe/http.js";
import { phonePeReadiness } from "../../lib/phonepe/config.js";
import { limitedText, verifyPhonePeWebhook } from "../../lib/phonepe/client.js";
import { PhonePeDbStore } from "../../lib/phonepe/store.js";
export async function phonePeWebhook(c: PhonePeContext) {
  const readiness = await phonePeReadiness(c.env, c.get("tenantId"));
  if (!readiness.gatesReady) return c.json({ error: "PhonePe disabled" }, 503);
  if (
    !(await verifyPhonePeWebhook(
      c.req.header("authorization"),
      c.env.PHONEPE_WEBHOOK_USERNAME!,
      c.env.PHONEPE_WEBHOOK_PASSWORD!,
    ))
  )
    return c.json({ error: "Invalid webhook authorization" }, 401);
  let d: any;
  try {
    d = JSON.parse(await limitedText(new Response(c.req.raw.body), 65536));
  } catch {
    return c.json({ error: "Invalid webhook body" }, 400);
  }
  const p = d?.payload;
  if (!p || p.merchantId !== c.env.PHONEPE_MERCHANT_ID)
    return c.json({ error: "Webhook merchant mismatch" }, 400);
  const event = d.event;
  const orderId =
    event === "checkout.order.completed" || event === "checkout.order.failed"
      ? p.merchantOrderId
      : p.originalMerchantOrderId;
  if (
    ![
      "checkout.order.completed",
      "checkout.order.failed",
      "pg.refund.completed",
      "pg.refund.failed",
    ].includes(event)
  )
    return c.json({ ignored: true });
  const store = new PhonePeDbStore(c.get("db"));
  if (
    typeof orderId !== "string" ||
    !(await store.order(c.get("tenantId"), orderId))
  )
    return c.json({ error: "Unrecognized order" }, 400);
  const refundId = event.startsWith("pg.refund.")
    ? p.merchantRefundId
    : undefined;
  if (
    event.startsWith("pg.refund.") &&
    (typeof refundId !== "string" ||
      !(await store.refund(c.get("tenantId"), refundId)))
  )
    return c.json(
      { error: "Refund correlation missing; reconcile through Admin" },
      400,
    );
  // SHA authenticates the sender, not the body. Never trust payload state/amount to
  // settle funds. Queue a server-authenticated GET; duplicated messages are safe.
  await c.env.BOOKING_QUEUE.send({
    type: "PHONEPE_RECONCILE",
    tenantId: c.get("tenantId"),
    merchantOrderId: orderId,
    ...(refundId ? { merchantRefundId: refundId } : {}),
  });
  return c.json({ accepted: true });
}
