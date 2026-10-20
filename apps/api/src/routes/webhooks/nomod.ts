import type { Handler } from "hono";
import { emailAgentTopup } from "../../lib/transactional-emails.js";
import { payments, bookings, walletTransactions } from "@poomas/db/schema";
import { creditAgentWallet } from "../../lib/agent-program.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";

// Nomod delivers webhooks through Svix: svix-id / svix-timestamp / svix-signature
// headers, signed with the endpoint's "whsec_…" signing secret.
// Events: charge.created | charge.authorised | charge.completed | charge.failed |
//         charge.cancelled | charge.refunded
const TOLERANCE_SECONDS = 5 * 60;

export const nomodWebhook: Handler<{ Bindings: Env; Variables: Variables }> = async (c) => {
  const rawBody = await c.req.text();

  if (!c.env.NOMOD_WEBHOOK_SECRET) {
    console.error("[nomod-webhook] NOMOD_WEBHOOK_SECRET is not configured");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  const valid = await verifySvixSignature(
    c.env.NOMOD_WEBHOOK_SECRET,
    c.req.header("svix-id") ?? "",
    c.req.header("svix-timestamp") ?? "",
    c.req.header("svix-signature") ?? "",
    rawBody,
  );
  if (!valid) {
    console.warn("[nomod-webhook] rejected: invalid or expired signature");
    return c.json({ error: "Invalid signature" }, 400);
  }

  let event: Record<string, any>;
  try { event = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const type   = String(event.type ?? event.event ?? event.event_type ?? "");
  const charge = (event.data?.object ?? event.data ?? event) as Record<string, any>;
  const chargeId = typeof charge.id === "string" ? charge.id : undefined;

  // Our payments row stores the Nomod link id as gatewayOrderId. The payload
  // shape carries it under a link/source field, so match on any id it contains.
  const db = c.get("db");
  const candidates = collectIds(event);
  const [payment] = candidates.length
    ? await db
        .select({ id: payments.id, bookingId: payments.bookingId, status: payments.status, gatewayOrderId: payments.gatewayOrderId, amount: payments.amount })
        .from(payments)
        .where(and(eq(payments.gateway, "NOMOD"), inArray(payments.gatewayOrderId, candidates)))
        .limit(1)
    : [];

  if (!payment) {
    // Agency wallet top-up (agent portal): credited once when the charge completes.
    for (const id of candidates.filter((x) => /^[\w-]{6,64}$/.test(x)).slice(0, 25)) {
      const topup = await c.env.SESSIONS_KV.get(`agent_topup:${id}`, "json").catch(() => null) as { tenantId: string; agentId: string; walletId: string; amount: number; currency: string; userId: string | null } | null;
      if (!topup) continue;
      if (type !== "charge.completed") return c.json({ ok: true, topup: "ignored" });
      const ref = `nomod:${id}`;
      const [already] = await db.select({ id: walletTransactions.id }).from(walletTransactions).where(eq(walletTransactions.paymentId, ref)).limit(1);
      if (already) return c.json({ ok: true, duplicate: true });
      const balance = await creditAgentWallet(db, topup.walletId, topup.amount, "TOPUP", { paymentId: ref, note: `Online top-up${chargeId ? ` · ${chargeId}` : ""}`, performedById: topup.userId ?? undefined });
      c.executionCtx.waitUntil(emailAgentTopup(c.env, db, topup.agentId, topup.amount, topup.currency, typeof balance === "number" ? balance : null, chargeId ?? id).catch(() => {}));
      await c.env.SESSIONS_KV.delete(`agent_topup:${id}`);
      console.info(`[nomod-webhook] agency top-up ${topup.amount} ${topup.currency} → agent ${topup.agentId}`);
      return c.json({ ok: true, topup: "credited" });
    }
    console.warn(`[nomod-webhook] ${type} ${chargeId ?? ""}: no matching NOMOD payment`, rawBody.slice(0, 500));
    return c.json({ ok: true, matched: false });
  }

  console.info(`[nomod-webhook] ${type} charge=${chargeId ?? "?"} link=${payment.gatewayOrderId} booking=${payment.bookingId}`);

  if (type === "charge.completed") {
    if (payment.status === "SUCCESS") return c.json({ ok: true, duplicate: true });

    await db.update(payments)
      .set({ status: "SUCCESS", gatewayPaymentId: chargeId ?? payment.gatewayOrderId, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    await db.update(bookings)
      .set({ status: "PAYMENT_PENDING", updatedAt: new Date() })
      .where(eq(bookings.id, payment.bookingId));

    await c.env.BOOKING_QUEUE.send({
      type:             "PAYMENT_CAPTURED",
      gatewayPaymentId: chargeId ?? payment.gatewayOrderId,
      orderId:          payment.gatewayOrderId,
      amount:           Number(payment.amount),
    });
  } else if (type === "charge.failed" || type === "charge.cancelled") {
    if (payment.status === "PENDING") {
      await db.update(payments)
        .set({ status: "FAILED", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
    }
  } else if (type === "charge.refunded") {
    await db.update(payments)
      .set({ status: "REFUNDED", updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
  }

  return c.json({ ok: true });
};

async function verifySvixSignature(
  secret: string, id: string, timestamp: string, header: string, body: string,
): Promise<boolean> {
  if (!id || !timestamp || !header) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
  } catch {
    console.error("[nomod-webhook] NOMOD_WEBHOOK_SECRET is not a valid whsec_ secret");
    return false;
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Header holds space-separated "v1,<base64>" entries (several during secret rotation).
  return header.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && sig !== undefined && timingSafeEqual(sig, expected);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Every short string in the payload, used to find the Nomod link id we stored.
function collectIds(value: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 6 || out.size >= 100) return [...out];
  if (typeof value === "string") {
    if (value.length > 0 && value.length <= 100) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectIds(v, out, depth + 1);
  }
  return [...out];
}
