import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import worker from "../src/sandbox-harness.js";
import { digest } from "../src/lib/phonepe/client.js";

// End-to-end harness run on local workerd D1 (production migration applied) with
// a simulated PhonePe sandbox. No Neon, Cloudflare account, credentials or network.
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: D1Database;
before(async () => {
  proxy = await getPlatformProxy({
    configPath: new URL("./phonepe/wrangler.d1-test.jsonc", import.meta.url).pathname,
    persist: false,
  });
  db = proxy.env.PHONEPE_DB as D1Database;
  const sql = (await readFile(new URL("../migrations/phonepe-d1/0001_phonepe_ledger.sql", import.meta.url), "utf8"))
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  await db.batch(sql.map((s) => db.prepare(s)));
});
after(async () => {
  await proxy?.dispose();
});

// ── Simulated PhonePe sandbox (stateful) ─────────────────────────────────────
const sim = {
  orders: new Map<string, { amount: number; state: string }>(),
  refunds: new Map<string, { amount: number; order: string; state: string }>(),
  payCalls: 0,
  refundCalls: 0,
};
const PP = "https://api-preprod.phonepe.com/apis/pg-sandbox";
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (!url.startsWith("https://api-preprod.phonepe.com/")) throw new Error(`unexpected host ${url}`);
  if (url.endsWith("/v1/oauth/token"))
    return Response.json({ access_token: "sim-token", token_type: "O-Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const body = init.body ? JSON.parse(init.body) : null;
  if (url === `${PP}/checkout/v2/pay`) {
    sim.payCalls++;
    sim.orders.set(body.merchantOrderId, { amount: body.amount, state: "PENDING" });
    return Response.json({ orderId: `OMO${body.merchantOrderId}`, state: "PENDING", expireAt: Date.now() + 1200000, redirectUrl: "https://mercury-uat.phonepe.com/transact/sim" });
  }
  let m = url.match(/\/checkout\/v2\/order\/([^/]+)\/status/);
  if (m) {
    const o = sim.orders.get(m[1])!;
    return Response.json({
      orderId: `OMO${m[1]}`, state: o.state, amount: o.amount,
      paymentDetails: o.state === "COMPLETED" ? [{ state: "COMPLETED", amount: o.amount, transactionId: `T${m[1]}` }] : [],
    });
  }
  if (url === `${PP}/payments/v2/refund`) {
    sim.refundCalls++;
    sim.refunds.set(body.merchantRefundId, { amount: body.amount, order: body.originalMerchantOrderId, state: "PENDING" });
    return Response.json({ refundId: `R${body.merchantRefundId}`, amount: body.amount, state: "PENDING" });
  }
  m = url.match(/\/payments\/v2\/refund\/([^/]+)\/status/);
  if (m) {
    const r = sim.refunds.get(m[1])!;
    return Response.json({ refundId: `R${m[1]}`, originalMerchantOrderId: r.order, amount: r.amount, state: r.state });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// ── Harness driver ───────────────────────────────────────────────────────────
const TOKEN = "local-fixture-harness-token-0123456789abcdef";
const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string, t?: string) => (kvStore.has(k) ? (t === "json" ? JSON.parse(kvStore.get(k)!) : kvStore.get(k)) : null),
  put: async (k: string, v: string) => void kvStore.set(k, v),
};
const baseEnv = () => ({
  ENVIRONMENT: "phonepe-sandbox-harness",
  PHONEPE_ENVIRONMENT: "sandbox",
  PHONEPE_TENANT_ID: "phonepe-sandbox-tenant",
  PHONEPE_DB: db,
  TENANT_CACHE_KV: kv,
  HARNESS_TOKEN: TOKEN,
  PHONEPE_CLIENT_ID: "fixture-client",
  PHONEPE_CLIENT_SECRET: "fixture-secret",
  PHONEPE_CLIENT_VERSION: "1",
  PHONEPE_MERCHANT_ID: "FIXTUREMERCHANT",
  PHONEPE_WEBHOOK_USERNAME: "fixture-user",
  PHONEPE_WEBHOOK_PASSWORD: "fixture-webhook-password",
  PHONEPE_RETURN_ORIGIN: "https://zamra-phonepe-sandbox.example.workers.dev",
});
const gates = { PHONEPE_SCHEMA_READY: "true", PHONEPE_MERCHANT_ACTIVE: "true", PHONEPE_RELEASE_APPROVED: "true" };
async function call(env: Record<string, unknown>, method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(
    new Request(`https://zamra-phonepe-sandbox.example.workers.dev${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env as any, ctx as any,
  );
  await Promise.all(pending); // queued reconciliation runs after the response
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const live = () => ({ ...baseEnv(), ...gates });

test("harness refuses to run outside an explicit sandbox configuration", async () => {
  for (const override of [
    { ENVIRONMENT: "production" },
    { PHONEPE_ENVIRONMENT: "production" },
    { PHONEPE_PRODUCTION_APPROVED: "true" },
    { PHONEPE_TENANT_ID: "real-tenant-id" },
    { HARNESS_TOKEN: "short" },
    { PHONEPE_DB: undefined },
  ]) {
    const r = await call({ ...live(), ...override }, "GET", "/health");
    assert.equal(r.status, 503, JSON.stringify(override));
  }
});
test("health is public; every control endpoint needs the harness token", async () => {
  const h = await call(live(), "GET", "/health", undefined, {});
  assert.equal(h.status, 200);
  assert.equal(h.data.env, "phonepe-sandbox-harness");
  assert.equal(h.data.phonePeEnvironment, "sandbox");
  assert.equal(JSON.stringify(h.data).includes("fixture-secret"), false);
  assert.equal((await call(live(), "POST", "/bookings", {}, {})).status, 401);
  assert.equal((await call(live(), "POST", "/bookings", {}, { authorization: "Bearer wrong-token-0123456789abcdef0123" })).status, 401);
});
test("PhonePe stays disabled until every gate passes and the opt-in is set", async () => {
  const b = (await call(baseEnv(), "POST", "/bookings", { amountMinor: 200 })).data;
  assert.equal((await call(baseEnv(), "POST", `/bookings/${b.bookingId}/checkout`)).status, 409);
  assert.equal((await call(baseEnv(), "PUT", "/settings/phonepe", { enabled: true })).status, 409);
  assert.equal((await call(live(), "POST", `/bookings/${b.bookingId}/checkout`)).data.error, "DISABLED");
  assert.equal(sim.payCalls, 0);
  assert.equal((await call(live(), "PUT", "/settings/phonepe", { enabled: true })).status, 200);
});
test("full sandbox flow: checkout, one gateway, webhook-driven reconcile, refunds", async () => {
  const env = live();
  const b = (await call(env, "POST", "/bookings", { amountMinor: 200 })).data;
  const first = await call(env, "POST", `/bookings/${b.bookingId}/checkout`);
  assert.equal(first.status, 200);
  assert.match(first.data.paymentUrl, /^https:\/\/[^/]+\.phonepe\.com\//);
  const again = await call(env, "POST", `/bookings/${b.bookingId}/checkout`);
  assert.equal(again.data.orderId, first.data.orderId);
  const payCalls = sim.payCalls;
  assert.equal((await call(env, "POST", `/bookings/${b.bookingId}/claim/NOMOD`)).status, 409);

  // Customer pays in the sandbox; PhonePe sends an authenticated webhook.
  sim.orders.get(first.data.orderId)!.state = "COMPLETED";
  const hook = (body: unknown, auth?: string) => call(env, "POST", "/webhooks/phonepe", body, auth ? { authorization: auth } : {});
  const sha = await digest("fixture-user:fixture-webhook-password");
  const forged = { event: "checkout.order.completed", payload: { merchantId: "FIXTUREMERCHANT", merchantOrderId: first.data.orderId, state: "COMPLETED", amount: 1 } };
  assert.equal((await hook(forged)).status, 401);
  assert.equal((await hook(forged, "Basic Zml4dHVyZQ==")).status, 401);
  assert.equal((await hook({ ...forged, payload: { ...forged.payload, merchantId: "OTHER" } }, sha)).status, 400);
  const accepted = await hook(forged, sha);
  assert.equal(accepted.status, 200);
  let state = (await call(env, "GET", `/bookings/${b.bookingId}`)).data;
  assert.equal(state.order.state, "COMPLETED"); // via the queued, authenticated status read
  assert.equal(state.order.amountMinor, 200); // webhook's amount (1) ignored
  assert.equal(state.order.transactionId, `T${first.data.orderId}`);
  assert.equal(state.booking.status, "PAYMENT_PENDING"); // never auto-confirmed
  assert.equal(state.claim, "PHONEPE");
  assert.equal(sim.payCalls, payCalls); // no extra charge attempts

  // Refunds: partial, replay, over-refund, completion, full.
  const reqA = crypto.randomUUID();
  const a = await call(env, "POST", "/refunds", { bookingId: b.bookingId, requestId: reqA, amountMinor: 100 });
  assert.equal(a.status, 200);
  assert.equal(a.data.state, "PENDING");
  const calls = sim.refundCalls;
  const replay = await call(env, "POST", "/refunds", { bookingId: b.bookingId, requestId: reqA, amountMinor: 100 });
  assert.equal(replay.data.merchantRefundId, a.data.merchantRefundId);
  assert.equal(sim.refundCalls, calls);
  assert.notEqual((await call(env, "POST", "/refunds", { bookingId: b.bookingId, requestId: crypto.randomUUID(), amountMinor: 200 })).status, 200);
  sim.refunds.get(a.data.merchantRefundId)!.state = "COMPLETED";
  assert.equal((await call(env, "POST", `/refunds/${a.data.merchantRefundId}/reconcile`)).data.state, "COMPLETED");
  state = (await call(env, "GET", `/bookings/${b.bookingId}`)).data;
  assert.equal(state.order.ledgerStatus, "PARTIAL_REFUND");
  const bRef = await call(env, "POST", "/refunds", { bookingId: b.bookingId, requestId: crypto.randomUUID(), amountMinor: 100 });
  sim.refunds.get(bRef.data.merchantRefundId)!.state = "COMPLETED";
  // Refund webhook path: authenticated event queues the refund status read.
  const refundHook = await hook({ event: "pg.refund.completed", payload: { merchantId: "FIXTUREMERCHANT", originalMerchantOrderId: first.data.orderId, merchantRefundId: bRef.data.merchantRefundId, state: "COMPLETED" } }, sha);
  assert.equal(refundHook.status, 200);
  state = (await call(env, "GET", `/bookings/${b.bookingId}`)).data;
  assert.equal(state.order.ledgerStatus, "REFUNDED");
  assert.equal(state.order.refundedMinor, 200);
  assert.equal(state.refunds.length, 2);
});
test("failed payment stays failed and still blocks other gateways; legacy claim blocks PhonePe", async () => {
  const env = live();
  const b = (await call(env, "POST", "/bookings", { amountMinor: 150 })).data;
  const o = (await call(env, "POST", `/bookings/${b.bookingId}/checkout`)).data;
  sim.orders.get(o.orderId)!.state = "FAILED";
  assert.equal((await call(env, "POST", `/bookings/${b.bookingId}/reconcile`)).data.paymentState, "FAILED");
  sim.orders.get(o.orderId)!.state = "PENDING"; // stale provider read cannot resurrect it
  assert.equal((await call(env, "POST", `/bookings/${b.bookingId}/reconcile`)).data.paymentState, "FAILED");
  assert.equal((await call(env, "POST", `/bookings/${b.bookingId}/claim/RAZORPAY`)).status, 409);
  const other = (await call(env, "POST", "/bookings", { amountMinor: 150 })).data;
  assert.equal((await call(env, "POST", `/bookings/${other.bookingId}/claim/WALLET`)).status, 200);
  const blocked = await call(env, "POST", `/bookings/${other.bookingId}/checkout`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, "CHECKOUT_GATEWAY_ALREADY_RESERVED");
});
test("synthetic data stays separate from the production ledger tables' tenants", async () => {
  const tenants = await db.prepare("SELECT DISTINCT tenant_id FROM phonepe_orders").all<{ tenant_id: string }>();
  assert.deepEqual(tenants.results.map((r) => r.tenant_id), ["phonepe-sandbox-tenant"]);
  const ids = await db.prepare("SELECT id FROM sandbox_bookings").all<{ id: string }>();
  assert.ok(ids.results.every((r) => r.id.startsWith("sbx-")));
});
test("harness Worker config binds only staging resources", async () => {
  const harnessToml = await readFile(new URL("../wrangler.sandbox-harness.toml", import.meta.url), "utf8");
  const prodToml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  const config = harnessToml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  // Same Cloudflare account, but no production KV/Hyperdrive/D1 resource id.
  const prodResources = prodToml.split("\n").filter((l) => !/^\s*(#|account_id)/.test(l)).join("\n").match(/[0-9a-f]{32}/g) ?? [];
  assert.ok(prodResources.length >= 4);
  for (const id of prodResources) assert.equal(config.includes(id), false, `production id ${id}`);
  assert.match(config, /^name = "zamra-phonepe-sandbox"$/m);
  assert.match(config, /^main = "src\/sandbox-harness\.ts"$/m);
  assert.match(config, /^workers_dev = true$/m);
  assert.match(config, /database_id\s+= "271aeba6-ace1-4102-aba2-dbcf0ec0a766"/);
  assert.match(config, /^PHONEPE_ENVIRONMENT = "sandbox"$/m);
  for (const forbidden of ["routes", "route =", "custom_domain", "[[queues", "[[hyperdrive", "[triggers]", "crons", "[[r2_buckets", "durable_objects", "DATABASE_URL", "PHONEPE_PRODUCTION_APPROVED"])
    assert.equal(config.includes(forbidden), false, forbidden);
  // The production API never mounts the harness.
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(index.includes("sandbox-harness"), false);
});
