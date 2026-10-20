// Payment gateway integration — Razorpay (INR) and Nomod (AED/USD)

// Only Nomod accepts new payments. Razorpay code stays for refunds and webhooks
// on payments taken before the switch; flip this to re-enable it for checkout.
export const RAZORPAY_ENABLED = false;

export interface GatewayOrderResult {
  gateway:     "RAZORPAY" | "NOMOD";
  orderId:     string;
  checkoutUrl?: string;   // Nomod hosted checkout URL
  keyId?:      string;    // Razorpay client-side key (non-secret)
  amount:      number;    // In smallest currency unit (paise/fils)
  currency:    string;
}

export interface RazorpayConfig {
  keyId:     string;
  keySecret: string;
}

export interface NomodConfig {
  apiKey:    string;
  apiSecret: string;
}

export async function createRazorpayOrder(
  config: RazorpayConfig,
  params: { amount: number; currency: string; receipt: string; notes?: Record<string, string> },
): Promise<GatewayOrderResult> {
  const auth = btoa(`${config.keyId}:${config.keySecret}`);

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      amount:   Math.round(params.amount * 100), // paise
      currency: params.currency,
      receipt:  params.receipt,
      notes:    params.notes ?? {},
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Razorpay order creation failed: ${err}`);
  }

  const order = await res.json() as { id: string; amount: number; currency: string };
  return {
    gateway:  "RAZORPAY",
    orderId:  order.id,
    keyId:    config.keyId,
    amount:   order.amount,
    currency: order.currency,
  };
}

export async function createNomodCheckout(
  config: NomodConfig,
  params: { amount: number; currency: string; reference: string; redirectUrl: string; description: string },
): Promise<GatewayOrderResult> {
  const res = await fetch("https://api.nomod.com/v1/checkouts", {
    method: "POST",
    headers: {
      "x-api-key":    config.apiKey,
      "x-api-secret": config.apiSecret,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      amount:      params.amount,
      currency:    params.currency,
      reference:   params.reference,
      redirect_url: params.redirectUrl,
      description: params.description,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nomod checkout creation failed: ${err}`);
  }

  const checkout = await res.json() as { id: string; checkout_url: string };
  return {
    gateway:     "NOMOD",
    orderId:     checkout.id,
    checkoutUrl: checkout.checkout_url,
    amount:      params.amount,
    currency:    params.currency,
  };
}

export async function createRefundRazorpay(
  config: RazorpayConfig,
  params: { paymentId: string; amount: number; notes?: Record<string, string> },
): Promise<{ refundId: string }> {
  const auth = btoa(`${config.keyId}:${config.keySecret}`);

  const res = await fetch(`https://api.razorpay.com/v1/payments/${params.paymentId}/refund`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(params.amount * 100),
      notes:  params.notes ?? {},
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Razorpay refund failed: ${err}`);
  }

  const refund = await res.json() as { id: string };
  return { refundId: refund.id };
}

export async function createRefundNomod(
  config: NomodConfig,
  params: { paymentId: string; amount: number; reason?: string },
): Promise<{ refundId: string }> {
  const res = await fetch(`https://api.nomod.com/v1/payments/${params.paymentId}/refunds`, {
    method: "POST",
    headers: {
      "x-api-key":    config.apiKey,
      "x-api-secret": config.apiSecret,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      amount: params.amount,
      reason: params.reason ?? "booking_failed",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nomod refund failed: ${err}`);
  }

  const refund = await res.json() as { id: string };
  return { refundId: refund.id };
}

// ── Nomod refunds for charges paid through a Nomod payment link ─────────────
//
// NOTE: Nomod's refund endpoint could not be verified against their public API
// reference from here. It is kept in one place so it can be corrected quickly.
// Callers treat anything other than an explicit 2xx as "not refunded", so a
// wrong endpoint can never mark a refund as paid.
export const nomodRefundUrl = (chargeId: string) =>
  `https://api.nomod.com/v1/charges/${encodeURIComponent(chargeId)}/refund`;

export type NomodRefundOutcome =
  | { ok: true; refundId: string; raw: unknown }
  | { ok: false; definite: true; httpStatus: number; error: string }   // Nomod answered: nothing refunded
  | { ok: false; definite: false; error: string };                      // no answer: outcome unknown

export async function refundNomodCharge(apiKey: string, chargeId: string, amount: number, reason: string): Promise<NomodRefundOutcome> {
  let res: Response;
  try {
    res = await fetch(nomodRefundUrl(chargeId), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ amount: amount.toFixed(2), reason }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, definite: false, error: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => "");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    return { ok: false, definite: true, httpStatus: res.status, error: (body?.error?.message ?? body?.message ?? text).toString().slice(0, 300) || `HTTP ${res.status}` };
  }
  return { ok: true, refundId: String(body?.id ?? body?.refund_id ?? body?.refund?.id ?? chargeId), raw: body };
}

// Tenant Nomod key: Admin → Settings value first, then the Worker secret.
export async function resolveNomodApiKey(env: { TENANT_CACHE_KV: { get(k: string): Promise<string | null> }; NOMOD_API_KEY?: string }, tenantId: string): Promise<string> {
  try {
    const raw = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`);
    const key = raw ? JSON.parse(raw)?.nomod?.apiKey : undefined;
    if (key) return key;
  } catch {}
  return env.NOMOD_API_KEY ?? "";
}
