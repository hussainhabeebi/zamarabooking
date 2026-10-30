import { freezeBookingPrice } from "../lib/booking-price-lock.js";
// POST /api/payments/checkout  — create Razorpay order or NoMod payment link
// POST /api/payments/verify    — verify Razorpay signature and confirm booking
// GET  /api/payments/checkout/:bookingId — poll payment status (used by queue-based flow)
// GET  /api/payments/:bookingId — get raw payment record

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { bookings, payments } from "@zamrabooking/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { issueTripToken } from "./trips.js";
import { RAZORPAY_ENABLED, nomodEnabled } from "../lib/payment-gateway.js";
import { convertAmount, getAedRate } from "../lib/fx.js";
import { createPhonePeOrder, getPhonePeToken, phonePeEnabled, phonePeMerchantOrderId, resolvePhonePeConfig } from "../lib/phonepe.js";
import { settlePhonePePayment } from "../lib/phonepe-settle.js";

export const paymentRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolvePaymentKeys(env: Env, settings: Record<string, any> | null, gateway: string) {
  if (gateway === "RAZORPAY") {
    const keyId     = settings?.razorpay?.keyId     || env.RAZORPAY_KEY_ID;
    const keySecret = settings?.razorpay?.keySecret || env.RAZORPAY_KEY_SECRET;
    return { keyId, keySecret };
  }
  if (gateway === "NOMOD") {
    const apiKey    = settings?.nomod?.apiKey    || env.NOMOD_API_KEY;
    const apiSecret = settings?.nomod?.apiSecret || env.NOMOD_API_SECRET;
    return { apiKey, apiSecret };
  }
  return {};
}

async function getTenantPaymentSettings(env: Env, tenantId: string) {
  const raw = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`);
  return raw ? JSON.parse(raw) : null;
}

// ── GET /api/payments/config — safe checkout configuration ───────────────────

paymentRoutes.get("/config", async (c) => {
  const tenantId = c.get("tenantId");
  const settings = await getTenantPaymentSettings(c.env, tenantId);
  const razorpayConfigured = RAZORPAY_ENABLED && Boolean(settings?.razorpay?.enabled && (settings.razorpay.keyId || c.env.RAZORPAY_KEY_ID));
  const nomodConfigured = nomodEnabled(settings) && Boolean(settings?.nomod?.apiKey || c.env.NOMOD_API_KEY);
  const phonePeConfigured = phonePeEnabled(settings) && Boolean(resolvePhonePeConfig(c.env, settings));
  const configured = { RAZORPAY: razorpayConfigured, NOMOD: nomodConfigured, PHONEPE: phonePeConfigured } as const;
  const wanted = settings?.defaultGateway as keyof typeof configured | undefined;
  const preferred = wanted && configured[wanted]
    ? wanted
    : nomodConfigured ? "NOMOD" : phonePeConfigured ? "PHONEPE" : razorpayConfigured ? "RAZORPAY" : null;
  const aedRate = await getAedRate(c.env, tenantId, c.executionCtx);
  return c.json({
    defaultGateway: preferred, gateways: configured,
    // Card payments can be made in INR, or in AED at the admin-set rate (INR per 1 AED).
    currencies: { INR: true, AED: Boolean(nomodConfigured && aedRate) }, aedRate,
  });
});

// ── POST /api/payments/checkout ───────────────────────────────────────────────

const checkoutSchema = z.object({
  bookingId: z.string(),
  gateway:   z.enum(["RAZORPAY", "NOMOD", "PHONEPE"]).default("NOMOD"),
  currency:  z.enum(["INR", "AED", "USD"]).optional(),
});

paymentRoutes.post("/checkout", zValidator("json", checkoutSchema), async (c) => {
  const { bookingId, gateway, currency } = c.req.valid("json");
  if (c.get("userRole") === "CHECKOUT" && c.get("checkoutBookingId") !== bookingId) {
    throw new HTTPException(403, { message: "Checkout session does not match this booking" });
  }
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [booking] = await db
    .select({
      id:          bookings.id,
      status:      bookings.status,
      totalAmount: bookings.totalAmount,
      currency:    bookings.currency,
      contactEmail: bookings.contactEmail,
      contactPhone: bookings.contactPhone,
      heldUntil:   bookings.heldUntil,
      flightData: bookings.flightData,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (!["HELD", "PAYMENT_PENDING"].includes(booking.status)) {
    throw new HTTPException(400, { message: `Booking is ${booking.status}` });
  }
  // Held fares (hold now, pay later) can't be paid after the airline's time limit.
  if (booking.status === "HELD" && booking.heldUntil && booking.heldUntil.getTime() < Date.now()) {
    throw new HTTPException(409, { message: "This hold has expired and the airline has released the seats. Please search again." });
  }

  const settings   = await getTenantPaymentSettings(c.env, tenantId);
  const cur        = currency ?? booking.currency;
  // Charge in the customer's chosen currency: convert the booking amount (the
  // booking itself stays in its own currency). Never send one currency's amount
  // labelled as another.
  const aedRate    = cur === booking.currency ? null : await getAedRate(c.env, tenantId, c.executionCtx);
  const converted  = convertAmount(parseFloat(booking.totalAmount), booking.currency, cur, aedRate);
  if (converted === null) {
    throw new HTTPException(400, { message: `Payment in ${cur} isn't available for this booking. Please pay in ${booking.currency}.` });
  }
  const amountFull = converted;
  const fx = cur === booking.currency ? undefined
    : { bookingAmount: Number(booking.totalAmount), bookingCurrency: booking.currency, rate: aedRate, rateUnit: `${booking.currency} per 1 ${cur}` };

  if (gateway === "RAZORPAY" && !RAZORPAY_ENABLED) {
    throw new HTTPException(400, { message: "Razorpay is disabled; pay with Nomod" });
  }

  if ((gateway === "RAZORPAY" || gateway === "PHONEPE") && cur !== booking.currency) {
    throw new HTTPException(400, { message: "Currency conversion is only available for Nomod payments" });
  }

  if (gateway === "RAZORPAY") {
    const { keyId, keySecret } = resolvePaymentKeys(c.env, settings, "RAZORPAY") as { keyId: string; keySecret: string };
    if (!keyId || !keySecret) throw new HTTPException(503, { message: "Razorpay not configured" });

    // Create Razorpay order (paise for INR, fils for AED)
    const amountMinor = Math.round(amountFull * 100);
    await freezeBookingPrice(db, tenantId, booking);
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      },
      body: JSON.stringify({
        amount:          amountMinor,
        currency:        cur,
        receipt:         bookingId,
        notes:           { tenantId, bookingId },
        payment_capture: 1,
      }),
    });

    if (!orderRes.ok) {
      const e = await orderRes.json() as { error?: { description?: string } };
      throw new HTTPException(502, { message: `Razorpay order failed: ${e.error?.description}` });
    }

    const order = await orderRes.json() as { id: string; amount: number; currency: string };

    // Record pending payment in DB
    await db.insert(payments).values({
      bookingId,
      gateway:        "RAZORPAY",
      gatewayOrderId: order.id,
      amount:         String(amountFull),
      currency:       cur as "INR" | "AED" | "USD",
      status:         "PENDING",
    });

    return c.json({ orderId: order.id, keyId, amount: order.amount, currency: order.currency });
  }

  if (gateway === "NOMOD") {
    const { apiKey } = resolvePaymentKeys(c.env, settings, "NOMOD") as { apiKey: string };
    if (!nomodEnabled(settings)) {
      throw new HTTPException(503, { message: "Nomod is switched off in Admin → Settings → Payments" });
    }
    if (!apiKey) {
      console.error("[payments] Nomod API key missing: set it in Admin → Settings → Payments or the NOMOD_API_KEY secret");
      throw new HTTPException(503, { message: "Nomod API key is missing" });
    }

    const checkoutToken = c.req.header("X-Checkout-Token") ?? "";
    const resultUrl = `https://zamrabooking.com/checkout/payment-result?bookingId=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(checkoutToken)}`;
    const amount = amountFull.toFixed(2);
    // A known pending link may be reused; an unknown outcome stays frozen.
    const existing=await db.select().from(payments).where(and(eq(payments.bookingId,bookingId),eq(payments.gateway,"NOMOD"),eq(payments.status,"PENDING")));
    const reusable=existing.find(p=>Number(p.amount)===amountFull&&p.currency===cur&&typeof (p.gatewayResponse as any)?.linkUrl==="string");
    if(reusable)return c.json({paymentUrl:(reusable.gatewayResponse as any).linkUrl,orderId:reusable.gatewayOrderId,amount:amountFull,currency:cur});
    await freezeBookingPrice(db, tenantId, booking);
    const linkRes = await fetch("https://api.nomod.com/v1/links", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        currency: cur,
        items: [{ name: `ZamraBooking flight booking ${bookingId.slice(0, 8)}`, amount, quantity: 1 }],
        title: "ZamraBooking flight booking",
        note: `Payment for booking ${bookingId}`,
        shipping_address_required: false,
        allow_tip: false,
        allow_tabby: settings?.nomod?.allowTabby ?? true,
        allow_tamara: settings?.nomod?.allowTamara ?? true,
        allow_service_fee: false,
        payment_expiry_limit: 1,
        success_url: `${resultUrl}&result=success`,
        failure_url: `${resultUrl}&result=failed`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const raw = await linkRes.text();
    let link: { id?: string; url?: string; amount?: string; currency?: string; error?: { message?: string } } = {};
    try { link = raw ? JSON.parse(raw) : {}; } catch {}
    if (!linkRes.ok || !link.id || !link.url) {
      const message = link.error?.message || raw.slice(0, 240) || `HTTP ${linkRes.status}`;
      throw new HTTPException(502, { message: `Nomod link failed: ${message}` });
    }

    await db.insert(payments).values({
      bookingId,
      gateway: "NOMOD",
      gatewayOrderId: link.id,
      amount: String(amountFull),
      currency: cur as "INR" | "AED" | "USD",
      status: "PENDING",
      gatewayResponse: { linkId: link.id, linkUrl: link.url, ...(fx ? { fx } : {}) },
    });

    return c.json({ paymentUrl: link.url, orderId: link.id, amount: Number(link.amount ?? amount), currency: link.currency ?? cur, ...(fx ? { fx } : {}) });
  }

  if (gateway === "PHONEPE") {
    if (!phonePeEnabled(settings)) {
      throw new HTTPException(503, { message: "PhonePe is switched off in Admin → Settings → Payments" });
    }
    const config = resolvePhonePeConfig(c.env, settings);
    if (!config) {
      console.error("[payments] PhonePe credentials missing: set them in Admin → Settings → Payments or the PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET secrets");
      throw new HTTPException(503, { message: "PhonePe credentials are missing" });
    }
    if (cur !== "INR") throw new HTTPException(400, { message: "PhonePe accepts INR only. Please pay in INR." });

    // A pending PhonePe order for the same amount is reused until shortly before it expires.
    const existing = await db.select().from(payments).where(and(eq(payments.bookingId, bookingId), eq(payments.gateway, "PHONEPE"), eq(payments.status, "PENDING")));
    const reusable = existing.find((p) => {
      const r = p.gatewayResponse as { redirectUrl?: string; expireAt?: number } | null;
      return Number(p.amount) === amountFull && typeof r?.redirectUrl === "string" && (r.expireAt ?? 0) - 60_000 > Date.now();
    });
    if (reusable) {
      return c.json({ paymentUrl: (reusable.gatewayResponse as any).redirectUrl, orderId: reusable.gatewayOrderId, amount: amountFull, currency: cur });
    }

    const checkoutToken = c.req.header("X-Checkout-Token") ?? "";
    const redirectUrl = `https://zamrabooking.com/checkout/payment-result?bookingId=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(checkoutToken)}&gateway=phonepe`;
    const merchantOrderId = phonePeMerchantOrderId(bookingId);
    await freezeBookingPrice(db, tenantId, booking);
    let order: { orderId: string; redirectUrl: string; expireAt?: number };
    try {
      const token = await getPhonePeToken(config, c.env.TENANT_CACHE_KV);
      order = await createPhonePeOrder(config, token, { merchantOrderId, amountInr: amountFull, redirectUrl, expireAfterSeconds: 20 * 60, bookingId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[payments] PhonePe order failed for booking ${bookingId}: ${message}`);
      throw new HTTPException(502, { message: `PhonePe order failed: ${message}` });
    }

    await db.insert(payments).values({
      bookingId,
      gateway: "PHONEPE",
      gatewayOrderId: merchantOrderId,
      amount: String(amountFull),
      currency: "INR",
      status: "PENDING",
      gatewayResponse: { phonePeOrderId: order.orderId, redirectUrl: order.redirectUrl, expireAt: order.expireAt ?? Date.now() + 20 * 60_000 },
    });

    return c.json({ paymentUrl: order.redirectUrl, orderId: merchantOrderId, amount: amountFull, currency: "INR" });
  }

  throw new HTTPException(400, { message: "Unsupported gateway" });
});

// ── POST /api/payments/verify — verify Razorpay signature + confirm booking ──

const verifySchema = z.object({
  bookingId:  z.string(),
  paymentId:  z.string(),
  orderId:    z.string(),
  signature:  z.string(),
  gateway:    z.enum(["RAZORPAY"]).default("RAZORPAY"),
});

paymentRoutes.post("/verify", zValidator("json", verifySchema), async (c) => {
  const { bookingId, paymentId, orderId, signature } = c.req.valid("json");
  const tenantId = c.get("tenantId");
  const db       = c.get("db");

  const settings = await getTenantPaymentSettings(c.env, tenantId);
  const { keySecret } = resolvePaymentKeys(c.env, settings, "RAZORPAY") as { keyId: string; keySecret: string };
  if (!keySecret) throw new HTTPException(503, { message: "Razorpay not configured" });

  // Verify HMAC-SHA256: sign(orderId + "|" + paymentId, keySecret)
  const message  = `${orderId}|${paymentId}`;
  const key      = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keySecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig    = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected !== signature) {
    throw new HTTPException(400, { message: "Invalid payment signature" });
  }

  // Mark payment as SUCCESS and queue booking confirmation
  await db.update(payments)
    .set({ status: "SUCCESS", gatewayPaymentId: paymentId, updatedAt: new Date() })
    .where(eq(payments.gatewayOrderId, orderId));

  await db.update(bookings)
    .set({ status: "PAYMENT_PENDING" as any, updatedAt: new Date() } as any)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)));

  await c.env.BOOKING_QUEUE.send({
    type:             "PAYMENT_CAPTURED",
    gatewayPaymentId: paymentId,
    orderId,
    bookingId,
    tenantId,
  });

  // Get updated PNR if already set
  const [booking] = await db
    .select({ pnr: bookings.pnr, status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  return c.json({ ok: true, pnr: booking?.pnr ?? null, status: booking?.status });
});

// ── GET /api/payments/checkout/:bookingId — poll status ──────────────────────

paymentRoutes.get("/checkout/:bookingId", async (c) => {
  const db        = c.get("db");
  const tenantId  = c.get("tenantId");
  const bookingId = c.req.param("bookingId");

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, totalAmount: bookings.totalAmount, currency: bookings.currency })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });

  const payUrlRaw = await c.env.SESSIONS_KV.get(`pay_url:${bookingId}`);
  if (!payUrlRaw) {
    return c.json({ bookingId, status: booking.status, totalAmount: booking.totalAmount, currency: booking.currency, ready: false });
  }

  return c.json({ bookingId, status: booking.status, totalAmount: booking.totalAmount, currency: booking.currency, ready: true, ...JSON.parse(payUrlRaw) });
});

// ── GET /api/payments/:bookingId — raw payment record ────────────────────────

paymentRoutes.get("/:bookingId", async (c) => {
  const db        = c.get("db");
  const tenantId  = c.get("tenantId");
  const bookingId = c.req.param("bookingId");
  if (c.get("userRole") === "CHECKOUT" && c.get("checkoutBookingId") !== bookingId) {
    throw new HTTPException(403, { message: "Checkout session does not match this booking" });
  }

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, pnr: bookings.pnr, userId: bookings.userId })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });

  // A booking can have several attempts (e.g. a failed Nomod try, then PhonePe):
  // report the paid one if any, else the latest attempt.
  const attempts = await db
    .select({
      id:               payments.id,
      gateway:          payments.gateway,
      gatewayOrderId:   payments.gatewayOrderId,
      gatewayPaymentId: payments.gatewayPaymentId,
      amount:           payments.amount,
      currency:         payments.currency,
      status:           payments.status,
      createdAt:        payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.bookingId, bookingId))
    .orderBy(desc(payments.createdAt));
  let payment = attempts.find((p) => ["SUCCESS", "REFUNDED", "PARTIAL_REFUND"].includes(p.status)) ?? attempts[0];

  // PhonePe's redirect carries no result: ask PhonePe while the attempt is pending.
  if (payment?.gateway === "PHONEPE" && payment.status === "PENDING") {
    try {
      const outcome = await settlePhonePePayment(c.env, db, tenantId, { ...payment, bookingId });
      if (outcome === "SUCCESS" || outcome === "FAILED") payment = { ...payment, status: outcome };
    } catch (err) {
      console.error(`[payments] PhonePe status check failed for booking ${bookingId}:`, err);
    }
  }

  // Once paid, hand the browser a read-only trip token so it can move on to the
  // itinerary confirmation page (the checkout token expires after 20 minutes).
  const paid = ["SUCCESS", "REFUNDED", "PARTIAL_REFUND"].includes(payment?.status ?? "");
  const tripToken = paid ? await issueTripToken(c, bookingId) : undefined;

  // Booking progress lets the payment-result page show "ticketed + PNR" once ready.
  return c.json({
    bookingId, payment: payment ?? null, tripToken,
    booking: { status: booking.status, pnr: booking.pnr, hasAccount: Boolean(booking.userId) },
  });
});
