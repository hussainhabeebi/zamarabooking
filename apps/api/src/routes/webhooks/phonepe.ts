import type { Handler } from "hono";
import { payments, bookings } from "@zamrabooking/db/schema";
import { and, eq } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { phonePeConfigForTenant, verifyPhonePeWebhookAuth } from "../../lib/phonepe.js";
import { settlePhonePePayment } from "../../lib/phonepe-settle.js";

// PhonePe webhook (checkout.order.completed / checkout.order.failed).
// Authorization: SHA256("<username>:<password>") with the webhook credentials set
// in the PhonePe dashboard. The payload is only used to find our order: its
// state is always re-read from PhonePe's order-status API before anything changes.
export const phonePeWebhook: Handler<{ Bindings: Env; Variables: Variables }> = async (c) => {
  let event: Record<string, any>;
  try { event = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const type = String(event.event ?? event.type ?? "");
  const merchantOrderId = String(event.payload?.merchantOrderId ?? event.payload?.originalMerchantOrderId ?? "");
  if (!merchantOrderId) {
    console.warn(`[phonepe-webhook] ${type}: no merchantOrderId`);
    return c.json({ ok: true, matched: false });
  }

  const db = c.get("db");
  const [payment] = await db
    .select({ id: payments.id, bookingId: payments.bookingId, gatewayOrderId: payments.gatewayOrderId, amount: payments.amount, status: payments.status, tenantId: bookings.tenantId })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.gateway, "PHONEPE"), eq(payments.gatewayOrderId, merchantOrderId)))
    .limit(1);
  if (!payment) {
    console.warn(`[phonepe-webhook] ${type} ${merchantOrderId}: no matching PHONEPE payment`);
    return c.json({ ok: true, matched: false });
  }

  const { settings } = await phonePeConfigForTenant(c.env, payment.tenantId);
  const username = settings?.phonepe?.webhookUsername || c.env.PHONEPE_WEBHOOK_USERNAME || "";
  const password = settings?.phonepe?.webhookPassword || c.env.PHONEPE_WEBHOOK_PASSWORD || "";
  if (!username || !password) {
    console.error("[phonepe-webhook] webhook username/password not configured");
    return c.json({ error: "Webhook not configured" }, 500);
  }
  if (!await verifyPhonePeWebhookAuth(c.req.header("Authorization"), username, password)) {
    console.warn("[phonepe-webhook] rejected: invalid authorization");
    return c.json({ error: "Invalid authorization" }, 401);
  }

  if (type.startsWith("pg.refund.")) {
    console.info(`[phonepe-webhook] ${type} ${merchantOrderId} state=${event.payload?.state ?? "?"}`);
    return c.json({ ok: true });
  }

  try {
    const outcome = await settlePhonePePayment(c.env, db, payment.tenantId, payment);
    console.info(`[phonepe-webhook] ${type} ${merchantOrderId} → ${outcome}`);
    return c.json({ ok: true, outcome });
  } catch (err) {
    // Non-2xx makes PhonePe retry the webhook later.
    console.error(`[phonepe-webhook] ${merchantOrderId} status check failed:`, err);
    return c.json({ error: "Status check failed" }, 503);
  }
};
