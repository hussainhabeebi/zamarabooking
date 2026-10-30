// PhonePe Payment Gateway — Standard Checkout v2 (INR only).
//
//   1. OAuth token   POST {identity}/v1/oauth/token  (client_credentials, form-encoded)
//   2. Create order  POST {pg}/checkout/v2/pay       → redirectUrl to PhonePe's hosted page
//   3. Order status  GET  {pg}/checkout/v2/order/{merchantOrderId}/status
//   4. Refund        POST {pg}/payments/v2/refund
//
// PhonePe's redirect back to us carries no result, so the payment is only ever
// marked paid after an order-status call says COMPLETED (from the webhook or
// from the payment-result page polling).

export interface PhonePeConfig {
  clientId:      string;
  clientSecret:  string;
  clientVersion: string;
  environment:   "sandbox" | "production";
}

export interface PhonePeSettings extends Partial<PhonePeConfig> {
  enabled?:         boolean;
  webhookUsername?: string;
  webhookPassword?: string;
}

export interface PhonePeEnv {
  TENANT_CACHE_KV: KVNamespace;
  PHONEPE_CLIENT_ID?:        string;
  PHONEPE_CLIENT_SECRET?:    string;
  PHONEPE_CLIENT_VERSION?:   string;
  PHONEPE_ENV?:              string;
  PHONEPE_WEBHOOK_USERNAME?: string;
  PHONEPE_WEBHOOK_PASSWORD?: string;
}

const HOSTS = {
  production: { identity: "https://api.phonepe.com/apis/identity-manager", pg: "https://api.phonepe.com/apis/pg" },
  sandbox:    { identity: "https://api-preprod.phonepe.com/apis/pg-sandbox", pg: "https://api-preprod.phonepe.com/apis/pg-sandbox" },
};

// PhonePe is on by default; only an explicit "off" saved in Admin → Settings disables it.
export function phonePeEnabled(settings: { phonepe?: { enabled?: boolean } } | null | undefined): boolean {
  return settings?.phonepe?.enabled !== false;
}

// Admin → Settings values first, then the Worker secrets. Null when credentials are missing.
export function resolvePhonePeConfig(env: Omit<PhonePeEnv, "TENANT_CACHE_KV">, settings: { phonepe?: PhonePeSettings } | null | undefined): PhonePeConfig | null {
  const s = settings?.phonepe ?? {};
  const clientId     = s.clientId     || env.PHONEPE_CLIENT_ID;
  const clientSecret = s.clientSecret || env.PHONEPE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const environment = (s.environment || env.PHONEPE_ENV) === "sandbox" ? "sandbox" : "production";
  return { clientId, clientSecret, clientVersion: s.clientVersion || env.PHONEPE_CLIENT_VERSION || "1", environment };
}

export async function phonePeConfigForTenant(env: PhonePeEnv, tenantId: string): Promise<{ config: PhonePeConfig | null; settings: { phonepe?: PhonePeSettings } | null }> {
  let settings: { phonepe?: PhonePeSettings } | null = null;
  try {
    const raw = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`);
    settings = raw ? JSON.parse(raw) : null;
  } catch {}
  return { config: resolvePhonePeConfig(env, settings), settings };
}

export class PhonePeError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly code?: string) { super(message); }
}

async function call<T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new PhonePeError(`PhonePe unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text().catch(() => "");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const message = String(body?.message ?? body?.error ?? text ?? "").slice(0, 300) || `HTTP ${res.status}`;
    throw new PhonePeError(`PhonePe: ${message}`, res.status, body?.code);
  }
  return body as T;
}

// Tokens are reused until shortly before they expire (cached in KV per client id).
export async function getPhonePeToken(config: PhonePeConfig, kv?: KVNamespace): Promise<string> {
  const cacheKey = `phonepe_token:${config.environment}:${config.clientId}`;
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, "json") as { token: string; expiresAt: number } | null;
      if (cached && cached.expiresAt - 120 > Date.now() / 1000) return cached.token;
    } catch {}
  }
  const data = await call<{ access_token?: string; expires_at?: number }>(`${HOSTS[config.environment].identity}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId, client_version: config.clientVersion,
      client_secret: config.clientSecret, grant_type: "client_credentials",
    }),
  }, 10_000);
  if (!data?.access_token) throw new PhonePeError("PhonePe did not return an access token");
  if (kv && data.expires_at) {
    const ttl = Math.floor(data.expires_at - Date.now() / 1000 - 120);
    if (ttl >= 60) await kv.put(cacheKey, JSON.stringify({ token: data.access_token, expiresAt: data.expires_at }), { expirationTtl: ttl }).catch(() => {});
  }
  return data.access_token;
}

const auth = (token: string) => ({ "Content-Type": "application/json", Authorization: `O-Bearer ${token}` });

// Our order id: letters, digits, "_" and "-" only, at most 63 characters.
export function phonePeMerchantOrderId(bookingId: string): string {
  return `ZB${bookingId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}_${Date.now().toString(36)}`;
}

export async function createPhonePeOrder(
  config: PhonePeConfig, token: string,
  params: { merchantOrderId: string; amountInr: number; redirectUrl: string; expireAfterSeconds: number; bookingId: string },
): Promise<{ orderId: string; redirectUrl: string; expireAt?: number }> {
  const data = await call<{ orderId?: string; redirectUrl?: string; expireAt?: number }>(`${HOSTS[config.environment].pg}/checkout/v2/pay`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({
      merchantOrderId: params.merchantOrderId,
      amount: Math.round(params.amountInr * 100),   // paise
      expireAfter: params.expireAfterSeconds,
      metaInfo: { udf1: params.bookingId },
      paymentFlow: {
        type: "PG_CHECKOUT",
        message: "ZamraBooking flight booking",
        merchantUrls: { redirectUrl: params.redirectUrl },
      },
    }),
  });
  if (!data?.orderId || !data.redirectUrl) throw new PhonePeError("PhonePe did not return a payment page");
  return { orderId: data.orderId, redirectUrl: data.redirectUrl, expireAt: data.expireAt };
}

export interface PhonePeOrderStatus {
  state:          "PENDING" | "COMPLETED" | "FAILED" | string;
  orderId?:       string;
  amountPaise?:   number;
  transactionId?: string;
  raw:            unknown;
}

export async function getPhonePeOrderStatus(config: PhonePeConfig, token: string, merchantOrderId: string): Promise<PhonePeOrderStatus> {
  const data = await call<any>(`${HOSTS[config.environment].pg}/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`, {
    method: "GET", headers: auth(token),
  }, 10_000);
  const details: any[] = Array.isArray(data?.paymentDetails) ? data.paymentDetails : [];
  const paid = details.find((d) => d?.state === "COMPLETED") ?? details[details.length - 1];
  return {
    state: String(data?.state ?? "PENDING"),
    orderId: data?.orderId,
    amountPaise: typeof data?.amount === "number" ? data.amount : undefined,
    transactionId: paid?.transactionId,
    raw: data,
  };
}

export type PhonePeRefundOutcome =
  | { ok: true; refundId: string; state: string }
  | { ok: false; definite: boolean; error: string };

export async function refundPhonePeOrder(
  config: PhonePeConfig, token: string,
  params: { merchantRefundId: string; merchantOrderId: string; amountInr: number },
): Promise<PhonePeRefundOutcome> {
  try {
    const data = await call<{ refundId?: string; state?: string }>(`${HOSTS[config.environment].pg}/payments/v2/refund`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        merchantRefundId: params.merchantRefundId,
        originalMerchantOrderId: params.merchantOrderId,
        amount: Math.round(params.amountInr * 100),
      }),
    });
    if (data?.state === "FAILED") return { ok: false, definite: true, error: "PhonePe rejected the refund" };
    return { ok: true, refundId: String(data?.refundId ?? params.merchantRefundId), state: String(data?.state ?? "PENDING") };
  } catch (err) {
    const e = err as PhonePeError;
    return { ok: false, definite: e.httpStatus !== undefined, error: e.message };
  }
}

// PhonePe sends Authorization: SHA256("<username>:<password>") as hex, using the
// credentials set for the webhook in the PhonePe dashboard.
export async function verifyPhonePeWebhookAuth(header: string | undefined, username: string, password: string): Promise<boolean> {
  if (!header || !username || !password) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${username}:${password}`));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.trim().replace(/^SHA256\s+/i, "").toLowerCase();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
