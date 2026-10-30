import test from "node:test";
import assert from "node:assert/strict";
import {
  createPhonePeOrder, getPhonePeOrderStatus, getPhonePeToken, phonePeEnabled, phonePeMerchantOrderId,
  refundPhonePeOrder, resolvePhonePeConfig, verifyPhonePeWebhookAuth, type PhonePeConfig,
} from "../src/lib/phonepe.js";
import { nomodEnabled } from "../src/lib/payment-gateway.js";

const config: PhonePeConfig = { clientId: "CID", clientSecret: "SECRET", clientVersion: "1", environment: "sandbox" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

test("Nomod and PhonePe are on unless explicitly switched off", () => {
  assert.equal(nomodEnabled(null), true);
  assert.equal(nomodEnabled({ nomod: {} }), true);
  assert.equal(nomodEnabled({ nomod: { enabled: false } }), false);
  assert.equal(phonePeEnabled(undefined), true);
  assert.equal(phonePeEnabled({ phonepe: { enabled: false } }), false);
});

test("PhonePe config: Admin values win over Worker secrets; missing secret means not configured", () => {
  const env = { PHONEPE_CLIENT_ID: "ENV_ID", PHONEPE_CLIENT_SECRET: "ENV_SECRET" };
  assert.deepEqual(resolvePhonePeConfig(env, null), { clientId: "ENV_ID", clientSecret: "ENV_SECRET", clientVersion: "1", environment: "production" });
  assert.equal(resolvePhonePeConfig(env, { phonepe: { clientId: "ADMIN_ID", environment: "sandbox" } })?.clientId, "ADMIN_ID");
  assert.equal(resolvePhonePeConfig({}, { phonepe: { clientId: "ADMIN_ID" } }), null);
});

test("merchant order ids fit PhonePe's 63-character limit and allowed characters", () => {
  const id = phonePeMerchantOrderId("3f2a1c9e-1234-4abc-9def-0123456789ab");
  assert.match(id, /^[A-Za-z0-9_-]{1,63}$/);
  assert.ok(id.startsWith("ZB3f2a1c9e"));
});

test("token is fetched with client credentials and cached until it nears expiry", async () => {
  const kv = memoryKv();
  const m = mockFetch(() => json({ access_token: "TOKEN1", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  try {
    assert.equal(await getPhonePeToken(config, kv), "TOKEN1");
    assert.equal(await getPhonePeToken(config, kv), "TOKEN1");
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].url, "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token");
    const body = new URLSearchParams(String(m.calls[0].init.body));
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_id"), "CID");
  } finally { m.restore(); }
});

test("create order sends paise and the redirect URL, and returns PhonePe's payment page", async () => {
  const m = mockFetch(() => json({ orderId: "OMO123", state: "PENDING", expireAt: 1, redirectUrl: "https://mercury.phonepe.com/pay" }));
  try {
    const order = await createPhonePeOrder(config, "TOKEN", { merchantOrderId: "ZB1_x", amountInr: 3741.5, redirectUrl: "https://zamrabooking.com/r", expireAfterSeconds: 1200, bookingId: "b1" });
    assert.equal(order.redirectUrl, "https://mercury.phonepe.com/pay");
    assert.equal(m.calls[0].url, "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay");
    assert.equal((m.calls[0].init.headers as Record<string, string>).Authorization, "O-Bearer TOKEN");
    const body = JSON.parse(String(m.calls[0].init.body));
    assert.equal(body.amount, 374150);
    assert.equal(body.paymentFlow.type, "PG_CHECKOUT");
    assert.equal(body.paymentFlow.merchantUrls.redirectUrl, "https://zamrabooking.com/r");
  } finally { m.restore(); }
});

test("order status picks the completed transaction", async () => {
  const m = mockFetch(() => json({ orderId: "OMO1", state: "COMPLETED", amount: 100, paymentDetails: [
    { transactionId: "T-FAIL", state: "FAILED" }, { transactionId: "T-OK", state: "COMPLETED" },
  ] }));
  try {
    const s = await getPhonePeOrderStatus(config, "TOKEN", "ZB1_x");
    assert.equal(s.state, "COMPLETED");
    assert.equal(s.transactionId, "T-OK");
    assert.equal(s.amountPaise, 100);
  } finally { m.restore(); }
});

test("refund errors are reported, never treated as refunded", async () => {
  const m = mockFetch(() => json({ code: "BAD_REQUEST", message: "Refund amount exceeds" }, 400));
  try {
    const r = await refundPhonePeOrder(config, "TOKEN", { merchantRefundId: "RF1", merchantOrderId: "ZB1_x", amountInr: 10 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.definite, true);
  } finally { m.restore(); }
});

test("webhook authorization is SHA256(username:password)", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("user:pass"));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyPhonePeWebhookAuth(hex, "user", "pass"), true);
  assert.equal(await verifyPhonePeWebhookAuth(`SHA256 ${hex}`, "user", "pass"), true);
  assert.equal(await verifyPhonePeWebhookAuth(hex, "user", "other"), false);
  assert.equal(await verifyPhonePeWebhookAuth(undefined, "user", "pass"), false);
});
