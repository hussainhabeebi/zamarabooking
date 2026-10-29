// PhonePe PG V2 Standard Checkout. Official contracts: developer.phonepe.com /
// payment-gateway/website-integration/standard-checkout/api-integration/api-reference/.
// Direct merchant integration only. Never log request bodies, tokens or responses.
export type PhonePeEnvironment = "sandbox" | "production";
export interface PhonePeCredentials {
  environment: PhonePeEnvironment;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clientVersion: string;
}
export class PhonePeError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(`PhonePe ${code}`);
  }
}
const bases = {
  sandbox: {
    auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    api: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  },
  production: {
    auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
    api: "https://api.phonepe.com/apis/pg",
  },
} as const;
const enc = new TextEncoder();
export async function digest(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyPhonePeWebhook(
  header: string | undefined,
  username: string,
  password: string,
) {
  if (!header || !username || !password || !/^[a-f0-9]{64}$/i.test(header))
    return false;
  const expected = await digest(`${username}:${password}`);
  let diff = 0;
  const actual = header.toLowerCase();
  for (let i = 0; i < 64; i++)
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}
export function minorAmount(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new PhonePeError("INVALID_AMOUNT");
  const [major, fraction = ""] = value.split(".");
  const amount = Number(major) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 100)
    throw new PhonePeError("INVALID_AMOUNT");
  return amount;
}
export function merchantId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(value))
    throw new PhonePeError("INVALID_REFERENCE");
  return value;
}
export function hostedUrl(value: unknown): string {
  if (typeof value !== "string") throw new PhonePeError("INVALID_CHECKOUT_URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".phonepe.com") ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new PhonePeError("INVALID_CHECKOUT_URL");
  return value;
}
export async function limitedText(
  response: Response,
  max = 131072,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new PhonePeError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(bytes);
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PhonePeError("INVALID_RESPONSE");
  return value as Record<string, any>;
}
export function orderEvidence(
  raw: unknown,
  expectedAmount: number,
  expectedOrderId: string | null,
) {
  const d = object(raw);
  if (
    typeof d.orderId !== "string" ||
    !d.orderId ||
    (expectedOrderId && d.orderId !== expectedOrderId) ||
    d.amount !== expectedAmount ||
    !["PENDING", "COMPLETED", "FAILED"].includes(d.state)
  )
    throw new PhonePeError("ORDER_MISMATCH");
  const paid = Array.isArray(d.paymentDetails)
    ? d.paymentDetails.filter(
        (p: any) =>
          p?.state === "COMPLETED" &&
          p.amount === expectedAmount &&
          typeof p.transactionId === "string" &&
          p.transactionId,
      )
    : [];
  if (d.state === "COMPLETED" && paid.length !== 1)
    throw new PhonePeError("PAYMENT_EVIDENCE_MISSING");
  return {
    orderId: d.orderId as string,
    state: d.state as "PENDING" | "COMPLETED" | "FAILED",
    amount: expectedAmount,
    transactionId: paid[0]?.transactionId as string | undefined,
  };
}
const tokens = new Map<string, { token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();
export class PhonePeClient {
  constructor(
    private c: PhonePeCredentials,
    private fetcher: typeof fetch = (i, o) => fetch(i, o),
    private now = () => Date.now(),
  ) {
    if (
      !bases[c.environment] ||
      !c.tenantId ||
      !c.clientId ||
      !c.clientSecret ||
      !/^\d+$/.test(c.clientVersion)
    )
      throw new PhonePeError("CREDENTIALS_MISSING");
  }
  async accountKey() {
    return digest(
      `${this.c.environment}\0${this.c.tenantId}\0${this.c.clientId}`,
    );
  }
  private async token(fresh = false): Promise<string> {
    const key = await digest(
      `${await this.accountKey()}\0${this.c.clientVersion}\0${this.c.clientSecret}`,
    );
    if (fresh) tokens.delete(key);
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > this.now() + 60000) return cached.token;
    const active = refreshing.get(key);
    if (active) return active;
    const work = (async () => {
      const body = new URLSearchParams({
        client_id: this.c.clientId,
        client_secret: this.c.clientSecret,
        client_version: this.c.clientVersion,
        grant_type: "client_credentials",
      });
      const d = await this.request(bases[this.c.environment].auth, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (
        typeof d.access_token !== "string" ||
        !d.access_token ||
        !Number.isSafeInteger(d.expires_at) ||
        d.expires_at * 1000 <= this.now() + 60000 ||
        d.token_type !== "O-Bearer"
      )
        throw new PhonePeError("INVALID_AUTH_RESPONSE");
      if (tokens.size >= 64) tokens.delete(tokens.keys().next().value!);
      tokens.set(key, {
        token: d.access_token,
        expiresAt: d.expires_at * 1000,
      });
      return d.access_token as string;
    })();
    refreshing.set(key, work);
    try {
      return await work;
    } finally {
      refreshing.delete(key);
    }
  }
  private async request(url: string, init: RequestInit) {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new PhonePeError("TRANSPORT_UNKNOWN");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PhonePeError("HTTP_ERROR", res.status);
    }
    try {
      return object(JSON.parse(await limitedText(res)));
    } catch (e) {
      if (e instanceof PhonePeError) throw e;
      throw new PhonePeError("INVALID_RESPONSE");
    }
  }
  private async api(
    path: string,
    body?: unknown,
    fresh = false,
  ): Promise<Record<string, any>> {
    const token = await this.token(fresh);
    try {
      return await this.request(`${bases[this.c.environment].api}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `O-Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      // Only a read may be retried; a payment/refund timeout is an unknown outcome.
      if (
        body === undefined &&
        !fresh &&
        e instanceof PhonePeError &&
        e.httpStatus === 401
      )
        return this.api(path, undefined, true);
      throw e;
    }
  }
  async checkout(id: string, amount: number, redirectUrl: string) {
    merchantId(id);
    if (
      !Number.isSafeInteger(amount) ||
      amount < 100 ||
      new URL(redirectUrl).protocol !== "https:"
    )
      throw new PhonePeError("INVALID_CHECKOUT");
    const d = await this.api("/checkout/v2/pay", {
      merchantOrderId: id,
      amount,
      expireAfter: 1200,
      paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl } },
    });
    if (
      typeof d.orderId !== "string" ||
      !d.orderId ||
      d.state !== "PENDING" ||
      !Number.isSafeInteger(d.expireAt)
    )
      throw new PhonePeError("INVALID_CHECKOUT_RESPONSE");
    return {
      orderId: d.orderId as string,
      paymentUrl: hostedUrl(d.redirectUrl),
      expiresAt: d.expireAt as number,
    };
  }
  orderStatus(id: string) {
    return this.api(`/checkout/v2/order/${merchantId(id)}/status?details=true`);
  }
  refund(id: string, original: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 100)
      throw new PhonePeError("INVALID_REFUND_AMOUNT");
    return this.api("/payments/v2/refund", {
      merchantRefundId: merchantId(id),
      originalMerchantOrderId: merchantId(original),
      amount,
    });
  }
  refundStatus(id: string) {
    return this.api(`/payments/v2/refund/${merchantId(id)}/status`);
  }
}
