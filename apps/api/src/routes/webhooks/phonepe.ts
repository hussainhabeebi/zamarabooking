import type { PhonePeContext } from "../../lib/phonepe/http.js";
import { limitedText, merchantId, verifyPhonePeWebhook } from "../../lib/phonepe/client.js";

const EVENTS = [
  "checkout.order.completed",
  "checkout.order.failed",
  "pg.refund.completed",
  "pg.refund.failed",
];
const reference = (v: unknown) => {
  try {
    return typeof v === "string" ? merchantId(v) : null;
  } catch {
    return null;
  }
};

// PhonePe webhook (SHA username/password mode). PhonePe expects a 2xx within a few
// seconds, including for the request it sends when a webhook is registered, so this
// handler does no database or provider I/O: it is mounted before tenant resolution
// (src/index.ts) and uses the configured PHONEPE_TENANT_ID.
//
// Order of checks: SHA authentication, then merchant, then event. Unauthenticated or
// wrong-merchant requests are rejected and never queue anything. An authenticated
// event is only queued for a server-authenticated status read (reconcilePhonePe);
// the payload's state/amount is never settlement evidence. Release gates, order and
// refund existence are enforced by that reconciliation, which refuses to run while
// PhonePe is disabled. A 200 means "received for verification", never "paid".
export async function phonePeWebhook(c: PhonePeContext) {
  const tenantId = c.env.PHONEPE_TENANT_ID;
  if (!tenantId || !c.env.PHONEPE_MERCHANT_ID || !c.env.PHONEPE_WEBHOOK_USERNAME || !c.env.PHONEPE_WEBHOOK_PASSWORD)
    return c.json({ error: "PhonePe webhook not configured" }, 503);
  if (!(await verifyPhonePeWebhook(c.req.header("authorization"), c.env.PHONEPE_WEBHOOK_USERNAME, c.env.PHONEPE_WEBHOOK_PASSWORD)))
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
  if (!EVENTS.includes(event)) return c.json({ ignored: true });
  const refund = event.startsWith("pg.refund.");
  const orderId = reference(refund ? p.originalMerchantOrderId : p.merchantOrderId);
  const refundId = refund ? reference(p.merchantRefundId) : null;
  // Authenticated but nothing we could reconcile (e.g. a registration test payload).
  if (!orderId || (refund && !refundId)) return c.json({ ignored: true });
  await c.env.BOOKING_QUEUE.send({
    type: "PHONEPE_RECONCILE",
    tenantId,
    merchantOrderId: orderId,
    ...(refundId ? { merchantRefundId: refundId } : {}),
  });
  return c.json({ accepted: true });
}
