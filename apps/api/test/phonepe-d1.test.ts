import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import {
  PhonePeD1Store,
  claimCheckoutGateway,
  claimLegacyGateway,
  phonePeLedgerStatus,
  ordersForBookings,
  phonePeReceipts,
  type Order,
} from "../src/lib/phonepe/store.js";
import { bookingsAdminRoutes } from "../src/routes/admin/bookings.js";
import { financeAdminRoutes } from "../src/routes/admin/finance.js";

// Local workerd D1 (in memory, persist: false) with the production migration.
// No Cloudflare account, remote database, credentials or provider requests.
const migration = new URL(
  "../migrations/phonepe-d1/0001_phonepe_ledger.sql",
  import.meta.url,
);
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: D1Database;
let serial = 0;
async function statements() {
  return (await readFile(migration, "utf8"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
async function migrate(target: D1Database) {
  // `wrangler d1 migrations apply` runs a migration file as one transaction.
  await target.batch((await statements()).map((s) => target.prepare(s)));
}
before(async () => {
  proxy = await getPlatformProxy({
    configPath: new URL("./phonepe/wrangler.d1-test.jsonc", import.meta.url)
      .pathname,
    persist: false,
  });
  db = proxy.env.PHONEPE_DB as D1Database;
  await migrate(db);
});
after(async () => {
  await proxy?.dispose();
});
const store = () => new PhonePeD1Store(db);
const scalar = async (sql: string, ...args: unknown[]) =>
  Object.values(
    (await db.prepare(sql).bind(...args).first<Record<string, unknown>>())!,
  )[0];
function draft(amount = 1000, tenantId = "fixture-tenant"): Order {
  const id = `fixture_${++serial}`;
  return {
    merchantOrderId: `ZP_${id}`,
    tenantId,
    bookingId: id,
    environment: "sandbox",
    accountKey: "fixture-account",
    amountMinor: amount,
    refundReservedMinor: 0,
    refundedMinor: 0,
    state: "INITIATED",
    providerOrderId: null,
    transactionId: null,
    checkoutUrl: null,
    expiresAt: null,
    updatedAt: new Date(),
  };
}
async function paid(amount = 1000) {
  const o = draft(amount);
  await store().reserve(o);
  await store().applyOrder(o, {
    state: "COMPLETED",
    orderId: `provider_${o.bookingId}`,
    transactionId: `transaction_${o.bookingId}`,
  });
  return (await store().order(o.tenantId, o.merchantOrderId))!;
}

test("migration is atomic: a repeated apply fails and changes nothing", async () => {
  const before = await scalar(
    "SELECT group_concat(sql, '|') FROM sqlite_master WHERE name LIKE 'phonepe%' OR name LIKE 'payment_checkout%'",
  );
  await assert.rejects(migrate(db));
  assert.equal(
    await scalar(
      "SELECT group_concat(sql, '|') FROM sqlite_master WHERE name LIKE 'phonepe%' OR name LIKE 'payment_checkout%'",
    ),
    before,
  );
});
test("16 concurrent checkout reservations create one order and exactly one owner", async () => {
  const o = draft();
  const rows = await Promise.all(
    Array.from({ length: 16 }, () => store().reserve(o)),
  );
  assert.equal(rows.filter((r) => r.owner).length, 1);
  assert.equal(
    await scalar(
      "SELECT count(*) FROM phonepe_orders WHERE booking_id = ?1",
      o.bookingId,
    ),
    1,
  );
});
test("a second merchant order for the same booking is refused, never a second charge", async () => {
  const o = draft();
  await store().reserve(o);
  await assert.rejects(
    store().reserve({ ...o, merchantOrderId: `${o.merchantOrderId}_other` }),
    /RESERVATION_FAILED/,
  );
});
test("competing hosted/wallet gateways cannot both claim a booking", async () => {
  const booking = `claim_${++serial}`;
  const gateways = ["PHONEPE", "NOMOD", "RAZORPAY", "WALLET"] as const;
  const rows = await Promise.allSettled(
    Array.from({ length: 16 }, async (_, i) => {
      await claimCheckoutGateway(db, "fixture-tenant", booking, gateways[i % 4]);
      return gateways[i % 4];
    }),
  );
  const winners = rows.filter(
    (r): r is PromiseFulfilledResult<(typeof gateways)[number]> =>
      r.status === "fulfilled",
  );
  assert.equal(new Set(winners.map((r) => r.value)).size, 1);
  assert.equal(winners.length, 4);
});
test("legacy gateway claim is a no-op while the flag is off and fails closed once on", async () => {
  // Flag off: D1 is never touched (binding deliberately absent).
  await claimLegacyGateway({} as any, "fixture-tenant", "legacy_off", "NOMOD");
  await assert.rejects(
    claimLegacyGateway(
      { PHONEPE_SCHEMA_READY: "true" } as any,
      "fixture-tenant",
      "legacy_missing_binding",
      "NOMOD",
    ),
    /PHONEPE_DB_MISSING/,
  );
  const env = { PHONEPE_SCHEMA_READY: "true", PHONEPE_DB: db } as any;
  const o = draft();
  await store().reserve(o);
  await assert.rejects(
    claimLegacyGateway(env, o.tenantId, o.bookingId, "NOMOD"),
    /PHONEPE_PAYMENT_EXISTS/,
  );
  await claimLegacyGateway(env, o.tenantId, "legacy_on", "RAZORPAY");
  await claimLegacyGateway(env, o.tenantId, "legacy_on", "RAZORPAY");
  await assert.rejects(
    claimLegacyGateway(env, o.tenantId, "legacy_on", "WALLET"),
    /CHECKOUT_GATEWAY_ALREADY_RESERVED/,
  );
});
test("20 duplicate full-refund reservations have exactly one owner and one debit", async () => {
  const o = await paid();
  const rows = await Promise.all(
    Array.from({ length: 20 }, () =>
      store().reserveRefund(o, `refund_${o.bookingId}`, 1000),
    ),
  );
  assert.equal(rows.filter((r) => r.owner).length, 1);
  assert.equal(
    await scalar(
      "SELECT refund_reserved_minor FROM phonepe_orders WHERE merchant_order_id = ?1",
      o.merchantOrderId,
    ),
    1000,
  );
});
test("competing partial refunds cannot reserve beyond captured funds", async () => {
  const o = await paid();
  const rows = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      store().reserveRefund(o, `partial_${o.bookingId}_${i}`, 400),
    ),
  );
  assert.equal(rows.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    await scalar(
      "SELECT refund_reserved_minor FROM phonepe_orders WHERE merchant_order_id = ?1",
      o.merchantOrderId,
    ),
    800,
  );
  assert.equal(
    await scalar(
      "SELECT count(*) FROM phonepe_refunds WHERE merchant_order_id = ?1",
      o.merchantOrderId,
    ),
    2,
  );
});
test("refunds are refused before payment completion", async () => {
  const o = draft();
  await store().reserve(o);
  await assert.rejects(
    store().reserveRefund(o, `early_${o.bookingId}`, 100),
    /REFUND_LIMIT_EXCEEDED/,
  );
});
test("concurrent refund completions and stale events retain the full aggregate", async () => {
  for (let i = 0; i < 6; i++) {
    const o = await paid();
    const a = await store().reserveRefund(o, `a_${o.bookingId}`, 400);
    const b = await store().reserveRefund(o, `b_${o.bookingId}`, 600);
    await Promise.all([
      store().applyRefund(a.refund, "COMPLETED", "provider_a"),
      store().applyRefund(b.refund, "COMPLETED", "provider_b"),
    ]);
    await Promise.all([
      store().applyRefund(a.refund, "FAILED", null),
      store().applyRefund(b.refund, "PENDING", null),
    ]);
    const after = (await store().order(o.tenantId, o.merchantOrderId))!;
    assert.equal(after.refundedMinor, 1000);
    assert.equal(phonePeLedgerStatus(after), "REFUNDED");
    assert.equal(
      (await store().refund(o.tenantId, a.refund.merchantRefundId))!
        .providerRefundId,
      "provider_a",
    );
  }
});
test("mixed duplicate payment events never downgrade success", async () => {
  const o = draft();
  await store().reserve(o);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store().applyOrder(o, {
        state: ["PENDING", "FAILED", "COMPLETED"][i % 3],
        orderId: "provider_order",
        transactionId: i % 3 === 2 ? "provider_transaction" : undefined,
      }),
    ),
  );
  const after = (await store().order(o.tenantId, o.merchantOrderId))!;
  assert.equal(after.state, "COMPLETED");
  assert.equal(after.transactionId, "provider_transaction");
  assert.equal(phonePeLedgerStatus(after), "SUCCESS");
});
test("large refund limits reject safely without integer overflow", async () => {
  const o = await paid(2147483647);
  await store().reserveRefund(o, `large_${o.bookingId}`, 1500000000);
  await assert.rejects(
    store().reserveRefund(o, `excess_${o.bookingId}`, 1500000000),
    /REFUND_LIMIT_EXCEEDED/,
  );
});
test("database constraints prevent cross-tenant refund links and invalid amounts", async () => {
  const o = await paid();
  const now = Date.now();
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO phonepe_refunds (merchant_refund_id, merchant_order_id, tenant_id, amount_minor, created_at, updated_at) VALUES (?1, ?2, 'other-fixture-tenant', 100, ?3, ?3)",
      )
      .bind(`cross_${o.bookingId}`, o.merchantOrderId, now)
      .run(),
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE phonepe_orders SET refund_reserved_minor = amount_minor + 1 WHERE merchant_order_id = ?1",
      )
      .bind(o.merchantOrderId)
      .run(),
  );
  await assert.rejects(store().reserve({ ...draft(99) }));
});

// ── Admin reports: D1 rows merged at read time, Neon mocked ──────────────────
// Each awaited Neon query returns the next fixture result; any write would throw.
function neon(results: unknown[][]) {
  let i = 0;
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then")
        return (ok: any, fail: any) => Promise.resolve(results[i++] ?? []).then(ok, fail);
      if (["insert", "update", "delete", "execute", "batch"].includes(String(prop)))
        throw new Error(`Neon ${String(prop)} attempted by a report`);
      return chain;
    },
    apply: () => chain,
  });
  return chain;
}
function adminApp(results: unknown[][], env: Record<string, unknown>, role = "TENANT_ADMIN") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, "fixture-tenant" as never);
    c.set("userRole" as never, role as never);
    c.set("db" as never, neon(results) as never);
    await next();
  });
  app.route("/bookings", bookingsAdminRoutes);
  app.route("/finance", financeAdminRoutes);
  const kv = { get: async () => null, put: async () => {} };
  return (path: string, init?: RequestInit) =>
    app.request(path, init, { TENANT_CACHE_KV: kv, ...env } as any);
}
const gateOn = () => ({ PHONEPE_SCHEMA_READY: "true", PHONEPE_DB: db });
const neonBooking = (id: string, tenantId = "fixture-tenant") => ({
  id, tenantId, status: "PAYMENT_PENDING", supplier: "MANUAL", userId: null, flightData: {},
  totalAmount: "10.00", currency: "INR", pnr: null,
});

test("ledger lookup is tenant-scoped and handles more than 100 bookings", async () => {
  const o = await paid();
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `none_${i}`, tenantId: "fixture-tenant" }));
  const found = await ordersForBookings(db, [...many, { id: o.bookingId, tenantId: o.tenantId }]);
  assert.deepEqual(found.map((x) => x.merchantOrderId), [o.merchantOrderId]);
  assert.equal((await ordersForBookings(db, [{ id: o.bookingId, tenantId: "other-tenant" }])).length, 0);
});
test("Admin booking list and detail show a D1 PhonePe payment once, beside Neon payments", async () => {
  const o = await paid();
  const nomod = { id: "neon-pay", bookingId: o.bookingId, gateway: "NOMOD", status: "FAILED", amount: "10.00", currency: "INR", createdAt: new Date() };
  const list = await (await adminApp([[neonBooking(o.bookingId), neonBooking("legacy-only")]], gateOn())("/bookings")).json();
  assert.equal(list.phonePe[o.bookingId], "SUCCESS");
  assert.equal(list.phonePe["legacy-only"], undefined);
  // Detail: loadBooking, then passengers, payments, amendments, support, wallet, exchanges.
  const detail = await (await adminApp([[neonBooking(o.bookingId)], [], [nomod], [], [], [], []], gateOn())(`/bookings/${o.bookingId}`)).json();
  assert.deepEqual(detail.payments.map((p: any) => `${p.gateway}:${p.status}`), ["NOMOD:FAILED", "PHONEPE:SUCCESS"]);
  const phonePeRow = detail.payments.find((p: any) => p.gateway === "PHONEPE");
  assert.equal(phonePeRow.ledger, "D1");
  assert.equal(phonePeRow.amount, "10.00");
  assert.equal(phonePeRow.gatewayPaymentId, `transaction_${o.bookingId}`);
  assert.equal(detail.phonePePaid, true);
  // Legacy "paid → retry airline booking" path is not triggered by PhonePe funds.
  assert.equal(detail.paymentConfirmed, false);
  assert.equal(detail.booking.status, "PAYMENT_PENDING");
});
test("Admin retry refuses to start a supplier booking from a PhonePe payment", async () => {
  const o = await paid();
  const res = await adminApp([[neonBooking(o.bookingId)]], gateOn())(`/bookings/${o.bookingId}/retry-booking`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /paid with PhonePe/);
});
test("Admin reports never read D1 while the PhonePe schema gate is off", async () => {
  const o = await paid();
  const touched = { n: 0 };
  const spy = { prepare: () => { touched.n++; throw new Error("D1 read while gate off"); } };
  const list = await (await adminApp([[neonBooking(o.bookingId)]], { PHONEPE_DB: spy })("/bookings")).json();
  assert.equal(list.phonePe, undefined);
  const detail = await (await adminApp([[neonBooking(o.bookingId)], [], [], [], [], [], []], { PHONEPE_DB: spy })(`/bookings/${o.bookingId}`)).json();
  assert.deepEqual(detail.payments, []);
  assert.equal(touched.n, 0);
});
test("finance reports PhonePe receipts separately from booking revenue, per environment", async () => {
  const before = await phonePeReceipts(db, "sandbox");
  const o = await paid(2500);
  const r = await store().reserveRefund(o, `fin_${o.bookingId}`, 500);
  await store().applyRefund(r.refund, "COMPLETED", "provider_fin");
  const after = await phonePeReceipts(db, "sandbox");
  assert.equal(after.payments - before.payments, 1);
  assert.equal(after.receivedMinor - before.receivedMinor, 2500);
  assert.equal(after.refundedMinor - before.refundedMinor, 500);
  assert.equal((await phonePeReceipts(db, "production")).payments, 0);
  const revenue = [[{ total: "1000" }], [{ total: "0" }], [{ total: "0" }], [{ total: "0" }], [{ total: "0" }], [{ cnt: 1 }], [{ avg: "1000" }]];
  const summary = await (await adminApp(revenue, gateOn(), "SUPER_ADMIN")("/finance/summary")).json();
  assert.equal(summary.totalRevenue, 1000); // booking-based figure is unchanged
  assert.equal(summary.phonePe.environment, "sandbox");
  assert.equal(summary.phonePe.receivedMinor, after.receivedMinor);
  const off = await (await adminApp(revenue, {}, "SUPER_ADMIN")("/finance/summary")).json();
  assert.equal(off.phonePe, undefined);
});
