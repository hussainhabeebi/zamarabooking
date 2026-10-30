import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { digest } from "../src/lib/phonepe/client.js";

// Regression for PhonePe webhook registration ("Webhook validation failed"): the
// validator gives up after ~1 s, and the staging Worker was doing a cold Neon tenant
// lookup and then answering 503 while PhonePe was disabled. These tests drive the
// real Worker entry point with NO DATABASE_URL and a KV that fails if touched, so
// any database/KV work on the webhook path, or a weakened check, fails here.
const USER = "fixture-webhook-user";
const PASS = "fixture-webhook-password";
const MERCHANT = "FIXTUREMERCHANT";
const url = "https://zamra-api-staging.example.workers.dev/webhooks/phonepe";
function env(gatesOn = false) {
  const queued: any[] = [];
  const e: any = {
    ENVIRONMENT: "staging",
    PLATFORM_TENANT_SLUG: "zamra",
    PHONEPE_ENVIRONMENT: "sandbox",
    PHONEPE_TENANT_ID: "tenant-fixture",
    PHONEPE_MERCHANT_ID: MERCHANT,
    PHONEPE_WEBHOOK_USERNAME: USER,
    PHONEPE_WEBHOOK_PASSWORD: PASS,
    ...(gatesOn ? { PHONEPE_SCHEMA_READY: "true", PHONEPE_MERCHANT_ACTIVE: "true", PHONEPE_RELEASE_APPROVED: "true" } : {}),
    TENANT_CACHE_KV: new Proxy({}, { get: () => () => { throw new Error("KV must not be used by the webhook"); } }),
    BOOKING_QUEUE: { send: async (m: unknown) => void queued.push(m) },
  };
  return { e, queued };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
async function post(e: any, body: unknown, auth?: string, path = url) {
  const res = await worker.fetch(
    new Request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
    ctx,
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const order = (merchantOrderId = "ZPregistrationcheck", event = "checkout.order.completed") => ({
  event,
  payload: { merchantId: MERCHANT, merchantOrderId, state: "COMPLETED", amount: 100 },
});

test("an authenticated registration check succeeds fast while PhonePe is disabled, with no DB or KV", async () => {
  const sha = await digest(`${USER}:${PASS}`);
  for (const body of [{ event: "webhook.test", payload: { merchantId: MERCHANT } }, order()]) {
    const { e, queued } = env(false);
    const r = await post(e, body, sha);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // Only ever a status-read request: never the payload's state or amount.
    for (const m of queued) assert.deepEqual(Object.keys(m).sort(), ["merchantOrderId", "tenantId", "type"]);
  }
});
test("unauthenticated or wrong-merchant requests are never acknowledged and queue nothing", async () => {
  const sha = await digest(`${USER}:${PASS}`);
  const wrong = await digest(`${USER}:not-the-password`);
  for (const gatesOn of [false, true]) {
    for (const [auth, body, status] of [
      [undefined, order(), 401],
      [`Basic ${btoa(`${USER}:${PASS}`)}`, order(), 401],
      [`SHA256 ${sha}`, order(), 401],
      [wrong, order(), 401],
      [sha, { ...order(), payload: { ...order().payload, merchantId: "OTHERMERCHANT" } }, 400],
      [sha, "not json", 400],
      [sha, { event: "checkout.order.completed" }, 400],
    ] as const) {
      const { e, queued } = env(gatesOn);
      const r = await post(e, body, auth);
      assert.equal(r.status, status, `${auth?.slice(0, 12)} ${JSON.stringify(body).slice(0, 60)}`);
      assert.deepEqual(queued, []);
    }
  }
});
test("authenticated events queue one status read; unusable references are ignored", async () => {
  const sha = await digest(`${USER}:${PASS}`);
  let { e, queued } = env(true);
  assert.equal((await post(e, order("ZP_order-1"), sha)).status, 200);
  assert.deepEqual(queued, [{ type: "PHONEPE_RECONCILE", tenantId: "tenant-fixture", merchantOrderId: "ZP_order-1" }]);
  ({ e, queued } = env(true));
  const refund = { event: "pg.refund.completed", payload: { merchantId: MERCHANT, originalMerchantOrderId: "ZP_order-1", merchantRefundId: "ZR_refund-1" } };
  assert.equal((await post(e, refund, sha)).status, 200);
  assert.deepEqual(queued, [{ type: "PHONEPE_RECONCILE", tenantId: "tenant-fixture", merchantOrderId: "ZP_order-1", merchantRefundId: "ZR_refund-1" }]);
  for (const bad of [order("../etc/passwd"), order(""), { event: "pg.refund.failed", payload: { merchantId: MERCHANT, originalMerchantOrderId: "ZP_order-1" } }]) {
    ({ e, queued } = env(true));
    const r = await post(e, bad, sha);
    assert.equal(r.status, 200);
    assert.equal(r.data.ignored, true);
    assert.deepEqual(queued, []);
  }
});
test("the tenant-lookup bypass is limited to POST /webhooks/phonepe", async () => {
  const { e } = env(true);
  // Without DATABASE_URL, every other route still hits tenant resolution (503).
  assert.equal((await post(e, {}, undefined, "https://zamra-api-staging.example.workers.dev/webhooks/nomod")).status, 503);
  const get = await worker.fetch(new Request(url), e, ctx);
  assert.equal(get.status, 503);
  const missing = env(true).e;
  delete missing.PHONEPE_TENANT_ID;
  assert.equal((await post(missing, order(), await digest(`${USER}:${PASS}`))).status, 503);
});
function batch(queue: string, body: unknown) {
  const msg = { id: "m1", attempts: 1, body, acked: 0, retried: 0, ack() { this.acked++; }, retry() { this.retried++; } };
  return { msg, batch: { queue, messages: [msg] } as any };
}
test("staging and production booking queues both run PhonePe reconciliation; final outcomes are acked", async () => {
  for (const queue of ["zamra-bookings", "zamra-bookings-staging"]) {
    // Gates off: reconciliation refuses (DISABLED) before any database or PhonePe call.
    const { e } = env(false);
    e.DATABASE_URL = "postgresql://fixture:fixture@fixture.invalid/fixture";
    e.TENANT_CACHE_KV = { get: async () => null, put: async () => {} }; // the consumer reads gates
    const { msg, batch: b } = batch(queue, { type: "PHONEPE_RECONCILE", tenantId: "tenant-fixture", merchantOrderId: "ZP_order-1" });
    await worker.queue(b, e);
    assert.deepEqual([msg.acked, msg.retried], [1, 0], queue);
  }
});
test("transient reconciliation failures are retried, not acknowledged", async () => {
  const { e } = env(true);
  Object.assign(e, {
    DATABASE_URL: "postgresql://fixture:fixture@fixture.invalid/fixture",
    PHONEPE_CLIENT_ID: "fixture", PHONEPE_CLIENT_SECRET: "fixture", PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_RETURN_ORIGIN: "https://zamra-web-staging.example.workers.dev",
    TENANT_CACHE_KV: { get: async () => null, put: async () => {} },
  });
  // The network guard makes every database/provider call fail, like an outage.
  const { msg, batch: b } = batch("zamra-bookings-staging", { type: "PHONEPE_RECONCILE", tenantId: "tenant-fixture", merchantOrderId: "ZP_order-1" });
  await worker.queue(b, e);
  assert.deepEqual([msg.acked, msg.retried], [0, 1]);
});
