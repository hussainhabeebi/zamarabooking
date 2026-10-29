import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  PhonePeClient,
  digest,
  minorAmount,
  hostedUrl,
  orderEvidence,
  verifyPhonePeWebhook,
} from "../src/lib/phonepe/client.js";
import { phonePeReadiness, phonePeClient } from "../src/lib/phonepe/config.js";
import { PhonePeService } from "../src/lib/phonepe/service.js";
import {
  PhonePeDbStore,
  type PhonePeStore,
  type Order,
  type Refund,
} from "../src/lib/phonepe/store.js";
import { phonePeAdminRoutes } from "../src/routes/admin/phonepe.js";
import { phonePeWebhook } from "../src/routes/webhooks/phonepe.js";

// All values below are local fixtures. No merchant credentials or actual transactions.
const credentials = () => ({
  environment: "sandbox" as const,
  tenantId: crypto.randomUUID(),
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
  clientVersion: "1",
});
const auth = () =>
  Response.json({
    access_token: "fixture-access",
    token_type: "O-Bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
const kv = (enabled = false) => ({
  get: async () => ({ enabled }),
  put: async () => {},
});
class MemoryStore implements PhonePeStore {
  orders = new Map<string, Order>();
  refunds = new Map<string, Refund>();
  ledger = new Map<string, string>();
  async order(t: string, id: string) {
    const o = this.orders.get(id);
    return o?.tenantId === t ? o : null;
  }
  async reserve(o: Order) {
    const old = this.orders.get(o.merchantOrderId);
    if (old) return { owner: false, order: old };
    this.orders.set(o.merchantOrderId, o);
    return { owner: true, order: o };
  }
  async checkout(id: string, r: any) {
    const o = this.orders.get(id)!;
    if (!["COMPLETED", "FAILED"].includes(o.state))
      Object.assign(o, {
        providerOrderId: r.orderId,
        checkoutUrl: r.paymentUrl,
        expiresAt: new Date(r.expiresAt),
        state: "PENDING",
      });
  }
  async unknown(id: string) {
    const o = this.orders.get(id)!;
    if (o.state === "INITIATED") o.state = "UNKNOWN";
  }
  async applyOrder(o: Order, e: any) {
    if (o.state !== "COMPLETED" || e.state === "COMPLETED")
      Object.assign(o, {
        state: e.state,
        providerOrderId: e.orderId,
        transactionId: e.transactionId ?? o.transactionId,
      });
    this.ledger.set(o.paymentId, o.state === "COMPLETED" ? "SUCCESS" : o.state);
  }
  async refund(t: string, id: string) {
    const r = this.refunds.get(id);
    return r?.tenantId === t ? r : null;
  }
  async reserveRefund(o: Order, id: string, a: number) {
    const r = this.refunds.get(id);
    if (r) return { owner: false, refund: r };
    if (o.refundReservedMinor + a > o.amountMinor) throw new Error("limit");
    o.refundReservedMinor += a;
    const row: Refund = {
      merchantRefundId: id,
      merchantOrderId: o.merchantOrderId,
      tenantId: o.tenantId,
      amountMinor: a,
      state: "INITIATED",
      providerRefundId: null,
      updatedAt: new Date(),
    };
    this.refunds.set(id, row);
    return { owner: true, refund: row };
  }
  async applyRefund(r: Refund, state: string, id: string | null) {
    if (r.state !== "COMPLETED" || state === "COMPLETED")
      Object.assign(r, { state, providerRefundId: id ?? r.providerRefundId });
  }
}

test("PhonePe stays disabled until every backend gate, tenant and Admin setting agrees", async () => {
  const e: any = {
    TENANT_CACHE_KV: kv(true),
    PHONEPE_CLIENT_ID: "fixture",
    PHONEPE_CLIENT_SECRET: "fixture",
    PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_RETURN_ORIGIN: "https://sandbox.example.test",
    PHONEPE_MERCHANT_ID: "fixture",
    PHONEPE_WEBHOOK_USERNAME: "fixture",
    PHONEPE_WEBHOOK_PASSWORD: "fixture",
    PHONEPE_TENANT_ID: "tenant",
  };
  assert.equal((await phonePeReadiness(e, "tenant")).enabled, false);
  await assert.rejects(phonePeClient(e, "tenant"));
  Object.assign(e, {
    PHONEPE_RELEASE_APPROVED: "true",
    PHONEPE_SCHEMA_READY: "true",
    PHONEPE_MERCHANT_ACTIVE: "true",
  });
  assert.equal((await phonePeReadiness(e, "tenant")).enabled, true);
  assert.equal((await phonePeReadiness(e, "other")).enabled, false);
  e.PHONEPE_ENVIRONMENT = "production";
  assert.equal((await phonePeReadiness(e, "tenant")).enabled, false);
  e.PHONEPE_PRODUCTION_APPROVED = "true";
  assert.equal((await phonePeReadiness(e, "tenant")).enabled, true);
});
test("Admin sees readiness only and cannot submit credentials or bypass gates", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("userRole" as never, "TENANT_ADMIN" as never);
    await next();
  });
  app.route("/phonepe", phonePeAdminRoutes);
  const e: any = {
    TENANT_CACHE_KV: kv(),
    PHONEPE_CLIENT_SECRET: "never-expose-this",
  };
  const body = await (await app.request("/phonepe", {}, e)).text();
  assert.doesNotMatch(body, /never-expose-this/);
  const send = (v: any) =>
    app.request(
      "/phonepe",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      },
      e,
    );
  assert.equal((await send({ enabled: true })).status, 409);
  assert.equal(
    (await send({ enabled: false, clientSecret: "forbidden" })).status,
    400,
  );
});
test("amounts are exact paise and hosted checkout rejects arbitrary redirect hosts", () => {
  assert.equal(minorAmount("123.01"), 12301);
  for (const a of ["-1", "0", "0.99", "1.001", "NaN", "1e3"])
    assert.throws(() => minorAmount(a));
  assert.equal(
    hostedUrl("https://mercury-uat.phonepe.com/transact?token=fixture"),
    "https://mercury-uat.phonepe.com/transact?token=fixture",
  );
  for (const u of [
    "https://evil.example",
    "https://phonepe.com.evil.example",
    "http://mercury.phonepe.com",
    "https://secret@mercury.phonepe.com",
  ])
    assert.throws(() => hostedUrl(u));
});
test("OAuth is form-encoded, expiry-aware and coalesces concurrent refreshes", async () => {
  let calls = 0;
  const c = credentials();
  const client = new PhonePeClient(c, async (url, init) => {
    if (String(url).endsWith("/oauth/token")) {
      calls++;
      assert.equal(
        new URLSearchParams(String(init?.body)).get("grant_type"),
        "client_credentials",
      );
      return auth();
    }
    assert.equal(
      (init?.headers as any).Authorization,
      "O-Bearer fixture-access",
    );
    return Response.json({ state: "PENDING" });
  });
  await Promise.all(
    Array.from({ length: 10 }, () => client.orderStatus("order-fixture")),
  );
  assert.equal(calls, 1);
});
test("expired token refreshes once for a GET, never replays a checkout POST", async () => {
  let tokens = 0,
    reads = 0,
    writes = 0;
  const client = new PhonePeClient(credentials(), async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      tokens++;
      return auth();
    }
    if (String(url).includes("/status")) {
      if (++reads === 1) return new Response("", { status: 401 });
      return Response.json({ state: "PENDING" });
    }
    writes++;
    return new Response("", { status: 401 });
  });
  await client.orderStatus("order-fixture");
  assert.equal(tokens, 2);
  assert.equal(reads, 2);
  await assert.rejects(
    client.checkout(
      "order-fixture",
      100,
      "https://zamrabooking.com/checkout/payment-result",
    ),
  );
  assert.equal(writes, 1);
});
test("webhook SHA authorization fails closed and does not accept HTTP Basic", async () => {
  const valid = await digest("fixture:password");
  assert.equal(await verifyPhonePeWebhook(valid, "fixture", "password"), true);
  for (const h of [undefined, "", "Basic Zm9vOmJhcg==", "0".repeat(64)])
    assert.equal(await verifyPhonePeWebhook(h, "fixture", "password"), false);
});
test("order amount, provider reference and completed transaction are mandatory evidence", () => {
  assert.throws(() =>
    orderEvidence({ state: "COMPLETED", amount: 100, orderId: "p" }, 100, "p"),
  );
  const good = {
    state: "COMPLETED",
    amount: 100,
    orderId: "p",
    paymentDetails: [
      { state: "COMPLETED", amount: 100, transactionId: "genuine-fixture" },
    ],
  };
  assert.equal(orderEvidence(good, 100, "p").transactionId, "genuine-fixture");
  assert.throws(() => orderEvidence(good, 200, "p"));
  assert.throws(() => orderEvidence(good, 100, "other"));
});
test("concurrent/repeated checkouts reserve once and no write is retried after a timeout", async () => {
  const store = new MemoryStore();
  let writes = 0;
  const creds = credentials();
  const client = new PhonePeClient(creds, async (url) => {
    if (String(url).endsWith("/oauth/token")) return auth();
    writes++;
    throw new Error("lost response");
  });
  const service = new PhonePeService(store, client, creds.tenantId, "sandbox");
  const b = { id: "booking", totalAmount: "10.00", currency: "INR" };
  await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      service.checkout(b, "https://zamrabooking.com/checkout/payment-result"),
    ),
  );
  assert.equal(writes, 1);
  assert.equal(store.orders.size, 1);
  assert.equal([...store.orders.values()][0].state, "UNKNOWN");
  await service.checkout(b, "https://zamrabooking.com/checkout/payment-result");
  assert.equal(writes, 1);
});
test("reconciliation is monotonic and never confirms a supplier or dispatches booking", async () => {
  const store = new MemoryStore();
  const creds = credentials();
  let state = "PENDING";
  const client = new PhonePeClient(creds, async (url) =>
    String(url).endsWith("/oauth/token")
      ? auth()
      : String(url).endsWith("/pay")
        ? Response.json({
            state: "PENDING",
            orderId: "provider-fixture",
            redirectUrl:
              "https://mercury-uat.phonepe.com/transact?token=fixture",
            expireAt: Date.now() + 60000,
          })
        : Response.json({
            state,
            orderId: "provider-fixture",
            amount: 1000,
            paymentDetails:
              state === "COMPLETED"
                ? [
                    {
                      state,
                      amount: 1000,
                      transactionId: "transaction-fixture",
                    },
                  ]
                : [],
          }),
  );
  const service = new PhonePeService(store, client, creds.tenantId, "sandbox");
  const first = await service.checkout(
    { id: "b", totalAmount: "10", currency: "INR" },
    "https://zamrabooking.com/checkout/payment-result",
  );
  state = "COMPLETED";
  const confirmed = await service.reconcile(first.orderId);
  assert.equal(confirmed.supplierConfirmed, false);
  state = "FAILED";
  await service.reconcile(first.orderId);
  assert.equal([...store.ledger.values()][0], "SUCCESS");
});
test("partial refunds reserve atomically, cannot over-refund or replay a lost refund", async () => {
  const store = new MemoryStore();
  const creds = credentials();
  let refundWrites = 0;
  const client = new PhonePeClient(creds, async (url) => {
    if (String(url).endsWith("/oauth/token")) return auth();
    refundWrites++;
    throw new Error("lost refund");
  });
  const order: Order = {
    merchantOrderId: "fixture-order",
    tenantId: creds.tenantId,
    bookingId: "b",
    paymentId: "p",
    environment: "sandbox",
    accountKey: await client.accountKey(),
    amountMinor: 1000,
    refundReservedMinor: 0,
    state: "COMPLETED",
    providerOrderId: "provider",
    transactionId: "tx",
    checkoutUrl: null,
    expiresAt: null,
    updatedAt: new Date(),
  };
  store.orders.set(order.merchantOrderId, order);
  const service = new PhonePeService(store, client, creds.tenantId, "sandbox");
  await assert.rejects(
    service.refund(order.merchantOrderId, "same-request", 600),
  );
  await service.refund(order.merchantOrderId, "same-request", 600);
  assert.equal(refundWrites, 1);
  await assert.rejects(
    service.refund(order.merchantOrderId, "other-request", 500),
  );
  assert.equal(refundWrites, 1);
  await assert.rejects(
    service.refund(order.merchantOrderId, "same-request", 400),
  );
});
test("a zero-insert racing refund reservation is not considered its owner", async () => {
  // Regression for INSERT ... SELECT yielding zero rows while another caller won.
  const refund: Refund = {
    merchantRefundId: "refund",
    merchantOrderId: "order",
    tenantId: "tenant",
    amountMinor: 100,
    state: "PENDING",
    providerRefundId: null,
    updatedAt: new Date(),
  };
  let reads = 0;
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (++reads === 1 ? [] : [refund]) }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  };
  const r = await new PhonePeDbStore(db).reserveRefund(
    { tenantId: "tenant", merchantOrderId: "order" } as Order,
    "refund",
    100,
  );
  assert.equal(r.owner, false);
});
test("an invalid webhook never parses data, changes ledger or queues reconciliation", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    await next();
  });
  app.post("/hook", phonePeWebhook);
  const e: any = {
    TENANT_CACHE_KV: kv(true),
    PHONEPE_TENANT_ID: "tenant",
    PHONEPE_CLIENT_ID: "fixture",
    PHONEPE_CLIENT_SECRET: "fixture",
    PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_RETURN_ORIGIN: "https://sandbox.example.test",
    PHONEPE_MERCHANT_ID: "fixture",
    PHONEPE_WEBHOOK_USERNAME: "fixture",
    PHONEPE_WEBHOOK_PASSWORD: "fixture",
    PHONEPE_SCHEMA_READY: "true",
    PHONEPE_MERCHANT_ACTIVE: "true",
    PHONEPE_RELEASE_APPROVED: "true",
    BOOKING_QUEUE: {
      send: () => {
        throw new Error("must not queue");
      },
    },
  };
  assert.equal(
    (
      await app.request(
        "/hook",
        {
          method: "POST",
          body: "not JSON",
          headers: { authorization: "invalid" },
        },
        e,
      )
    ).status,
    401,
  );
});

test("disabling new checkout still permits existing-order reconciliation after release gates passed", async () => {
  const e: any = {
    TENANT_CACHE_KV: kv(false),
    PHONEPE_TENANT_ID: "tenant",
    PHONEPE_CLIENT_ID: "fixture",
    PHONEPE_CLIENT_SECRET: "fixture",
    PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_RETURN_ORIGIN: "https://sandbox.example.test",
    PHONEPE_MERCHANT_ID: "fixture",
    PHONEPE_WEBHOOK_USERNAME: "fixture",
    PHONEPE_WEBHOOK_PASSWORD: "fixture",
    PHONEPE_SCHEMA_READY: "true",
    PHONEPE_MERCHANT_ACTIVE: "true",
    PHONEPE_RELEASE_APPROVED: "true",
  };
  await assert.rejects(phonePeClient(e, "tenant"));
  assert.ok(await phonePeClient(e, "tenant", true));
});
test("shared checkout claims cannot switch payment providers for the same booking", async () => {
  const { claimCheckoutGateway } = await import("../src/lib/phonepe/store.js");
  let selected: string | null = null;
  const db: any = {
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: async () => {
          selected ??= v.gateway;
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (selected ? [{ gateway: selected }] : []),
        }),
      }),
    }),
  };
  await Promise.all([
    claimCheckoutGateway(db, "tenant", "booking", "PHONEPE"),
    claimCheckoutGateway(db, "tenant", "booking", "PHONEPE"),
  ]);
  await assert.rejects(claimCheckoutGateway(db, "tenant", "booking", "NOMOD"));
  assert.equal(selected, "PHONEPE");
});
test("the generic supplier booking queue refuses a PhonePe payment before any supplier operation", async (t) => {
  const { processPaidBooking } = await import("../src/queue-consumer.js");
  const old = globalThis.fetch;
  let calls = 0;
  t.after(() => {
    globalThis.fetch = old;
  });
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      fields: [
        { name: "bookingId", dataTypeID: 25 },
        { name: "gateway", dataTypeID: 25 },
      ],
      rows: [["booking", "PHONEPE"]],
      rowCount: 1,
      command: "SELECT",
      rowAsArray: true,
    });
  };
  await processPaidBooking(
    {
      DATABASE_URL: "postgresql://fixture:fixture@fixture.neon.tech/fixture",
    } as any,
    {
      type: "PAYMENT_CAPTURED",
      orderId: "fixture",
      gatewayPaymentId: "fixture",
      amount: 10,
    },
  );
  assert.equal(calls, 1);
});

test("an authenticated webhook queues only a status read and ignores claimed payment state", async () => {
  const sent: any[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set(
      "db" as never,
      {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { merchantOrderId: "order", tenantId: "tenant" },
              ],
            }),
          }),
        }),
      } as never,
    );
    await next();
  });
  app.post("/hook", phonePeWebhook);
  const e: any = {
    TENANT_CACHE_KV: kv(true),
    PHONEPE_TENANT_ID: "tenant",
    PHONEPE_CLIENT_ID: "fixture",
    PHONEPE_CLIENT_SECRET: "fixture",
    PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_RETURN_ORIGIN: "https://sandbox.example.test",
    PHONEPE_MERCHANT_ID: "fixture",
    PHONEPE_WEBHOOK_USERNAME: "fixture",
    PHONEPE_WEBHOOK_PASSWORD: "password",
    PHONEPE_SCHEMA_READY: "true",
    PHONEPE_MERCHANT_ACTIVE: "true",
    PHONEPE_RELEASE_APPROVED: "true",
    BOOKING_QUEUE: {
      send: async (v: any) => {
        sent.push(v);
      },
    },
  };
  const payload = {
    event: "checkout.order.completed",
    payload: {
      merchantId: "fixture",
      merchantOrderId: "order",
      state: "COMPLETED",
      amount: 999999999,
    },
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await app.request(
          "/hook",
          {
            method: "POST",
            headers: { authorization: await digest("fixture:password") },
            body: JSON.stringify(payload),
          },
          e,
        )
      ).status,
      200,
    );
  assert.equal(sent.length, 2);
  assert.ok(sent.every((x) => x.type === "PHONEPE_RECONCILE"));
  assert.equal(
    sent.some((x) => "amount" in x || "state" in x),
    false,
  );
});
test("a refund is not completed until its exact order, amount and provider ID reconcile", async () => {
  const store = new MemoryStore();
  const c = credentials();
  let mismatch = false;
  const client = new PhonePeClient(c, async (url) =>
    String(url).endsWith("/oauth/token")
      ? auth()
      : Response.json({
          originalMerchantOrderId: mismatch ? "other" : "order",
          amount: 500,
          state: "COMPLETED",
          refundId: "refund-provider",
        }),
  );
  const o: Order = {
    merchantOrderId: "order",
    tenantId: c.tenantId,
    bookingId: "b",
    paymentId: "p",
    environment: "sandbox",
    accountKey: await client.accountKey(),
    amountMinor: 1000,
    refundReservedMinor: 500,
    state: "COMPLETED",
    providerOrderId: "po",
    transactionId: "pt",
    checkoutUrl: null,
    expiresAt: null,
    updatedAt: new Date(),
  };
  store.orders.set("order", o);
  const r: Refund = {
    merchantRefundId: "refund",
    merchantOrderId: "order",
    tenantId: c.tenantId,
    amountMinor: 500,
    state: "PENDING",
    providerRefundId: "refund-provider",
    updatedAt: new Date(),
  };
  store.refunds.set("refund", r);
  const service = new PhonePeService(store, client, c.tenantId, "sandbox");
  mismatch = true;
  await assert.rejects(service.reconcileRefund("refund"));
  assert.equal(r.state, "PENDING");
  mismatch = false;
  await service.reconcileRefund("refund");
  assert.equal(r.state, "COMPLETED");
});

test("legacy Nomod hosted checkout remains unchanged while PhonePe is disabled", async (t) => {
  const { paymentRoutes } = await import("../src/routes/payments.js");
  const old = globalThis.fetch;
  const sent: any[] = [];
  const inserted: any[] = [];
  t.after(() => {
    globalThis.fetch = old;
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.nomod.com/v1/links");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "nomod-fixture",
      url: "https://pay.nomod.com/fixture",
      amount: "10.00",
      currency: "INR",
    });
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("userRole" as never, "CHECKOUT" as never);
    c.set("checkoutBookingId" as never, "booking" as never);
    c.set(
      "db" as never,
      {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  id: "booking",
                  status: "PAYMENT_PENDING",
                  totalAmount: "10.00",
                  currency: "INR",
                  contactEmail: "fixture@example.test",
                  contactPhone: "919999999999",
                  heldUntil: null,
                },
              ],
            }),
          }),
        }),
        insert: () => ({
          values: async (v: any) => {
            inserted.push(v);
          },
        }),
      } as never,
    );
    await next();
  });
  app.route("/payments", paymentRoutes);
  const e: any = {
    JWT_SECRET: "local-test-only",
    TENANT_CACHE_KV: {
      get: async () =>
        JSON.stringify({ nomod: { enabled: true, apiKey: "fixture" } }),
    },
  };
  const response = await app.request(
    "/payments/checkout",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: "booking",
        gateway: "NOMOD",
        currency: "INR",
      }),
    },
    e,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).paymentUrl,
    "https://pay.nomod.com/fixture",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].items[0].amount, "10.00");
  assert.equal(sent[0].currency, "INR");
  assert.equal(inserted[0].gateway, "NOMOD");
  assert.equal(inserted[0].status, "PENDING");
});
