import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { getTableName, is, Table } from "drizzle-orm";
import { settleRefund } from "../src/lib/trips.js";
import { cancellationsAdminRoutes } from "../src/routes/admin/post-booking.js";
import { bookingsAdminRoutes } from "../src/routes/admin/bookings.js";
import { financeAdminRoutes } from "../src/routes/admin/finance.js";

// Double-refund protections and Admin reporting for PhonePe payments in the Neon
// ledger. A recording Neon double: each awaited SELECT returns the next fixture,
// and every write is recorded so tests can prove which tables were (not) touched.
function neon(selects: unknown[][], returning: Record<string, unknown[]> = {}) {
  const writes: { op: string; table: string; values?: any }[] = [];
  const name = (t: unknown) => (is(t, Table) ? getTableName(t as Table) : "?");
  const chain = (op: string, table = "?") => {
    const state: { op: string; table: string; values?: any } = { op, table };
    const p: any = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const result = op === "select" ? (selects.shift() ?? []) : (writes.push(state), returning[state.table] ?? []);
          return (ok: any, fail: any) => Promise.resolve(result).then(ok, fail);
        }
        return (...args: any[]) => {
          if (prop === "from") state.table = name(args[0]);
          if (prop === "set" || prop === "values") state.values = args[0];
          return p;
        };
      },
    });
    return p;
  };
  const db = { select: () => chain("select"), update: (t: unknown) => chain("update", name(t)), insert: (t: unknown) => chain("insert", name(t)) };
  return { db, writes };
}
const gateOn = { PHONEPE_SCHEMA_READY: "true" };
const amendment = {
  id: "amend-1", bookingId: "booking-1", tenantId: "tenant", status: "SUCCESS", refundStatus: "PENDING",
  refundAmount: "10.00", amountPaid: "10.00", currency: "INR", refundMethod: "WALLET",
};
const phonePePayment = { gateway: "PHONEPE", gatewayPaymentId: "T1", amount: "10.00", currency: "INR" };
function app(db: unknown, env: Record<string, unknown>, role = "TENANT_ADMIN") {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("tenantId" as never, "tenant" as never);
    c.set("userRole" as never, role as never);
    c.set("db" as never, db as never);
    await next();
  });
  a.route("/cancellations", cancellationsAdminRoutes);
  a.route("/bookings", bookingsAdminRoutes);
  a.route("/finance", financeAdminRoutes);
  const kv = { get: async () => null, put: async () => {} };
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
  return (path: string, init?: RequestInit) => a.request(path, init, { TENANT_CACHE_KV: kv, ...env } as any, ctx as any);
}
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a PhonePe cancellation is never auto-refunded to a wallet or marked paid", async () => {
  const claimed = { ...amendment, refundStatus: "PROCESSING", refundMethod: "PHONEPE" };
  const { db, writes } = neon(
    [[{ userId: "customer", agentId: null }], [phonePePayment], [{ id: "PP_ZP1" }]],
    { booking_amendments: [claimed] },
  );
  await settleRefund(db as any, gateOn as any, amendment as any);
  assert.deepEqual(writes.map((w) => `${w.op}:${w.table}`), ["update:booking_amendments", "update:booking_amendments"]);
  assert.equal(writes[0].values.refundMethod, "PHONEPE");
  assert.equal(writes[1].values.refundStatus, "MANUAL_REQUIRED");
  assert.match(writes[1].values.refundError, /PhonePe refunds/);
});
test("a partially refunded PhonePe payment is still recognised (no 'unknown' manual refund)", async () => {
  const claimed = { ...amendment, refundStatus: "PROCESSING", refundMethod: "PHONEPE" };
  // No SUCCESS row any more (status PARTIAL_REFUND), but the PhonePe lookup finds it.
  const { db, writes } = neon([[{ userId: "customer", agentId: null }], [], [{ id: "PP_ZP1" }]], { booking_amendments: [claimed] });
  await settleRefund(db as any, gateOn as any, amendment as any);
  assert.equal(writes[0].values.refundMethod, "PHONEPE");
  assert.equal(writes.some((w) => w.table === "payments" || w.table.startsWith("wallet")), false);
});
test("Admin cannot mark a PhonePe refund done until PhonePe confirmed refunds cover it", async () => {
  // loadAmendment, PhonePe payment lookup, confirmed PhonePe refunds (₹5 of ₹10).
  const short = neon([[amendment], [{ id: "PP_ZP1" }], [{ total: "500" }]]);
  const r = await app(short.db, gateOn)("/cancellations/amend-1/resolve", post({ action: "MARK_REFUNDED_MANUALLY", note: "paid by bank transfer" }));
  assert.equal(r.status, 409);
  assert.match(await r.text(), /PhonePe has confirmed ₹5\.00 of ₹10\.00/);
  assert.deepEqual(short.writes, []);

  const done = { ...amendment, refundStatus: "DONE" };
  const covered = neon([[amendment], [{ id: "PP_ZP1" }], [{ total: "1000" }]], { booking_amendments: [done] });
  const ok = await app(covered.db, gateOn)("/cancellations/amend-1/resolve", post({ action: "MARK_REFUNDED_MANUALLY", note: "PhonePe refund confirmed" }));
  assert.equal(ok.status, 200);
  // The PhonePe payments row is maintained only by confirmed PhonePe refunds.
  assert.equal(covered.writes.some((w) => w.table === "payments"), false);
  assert.deepEqual(covered.writes.map((w) => `${w.op}:${w.table}`).slice(0, 2), ["update:booking_amendments", "update:bookings"]);
});
test("non-PhonePe manual refunds behave as before", async () => {
  const done = { ...amendment, refundStatus: "DONE" };
  for (const env of [{}, gateOn]) {
    const { db, writes } = neon(env === gateOn ? [[amendment], []] : [[amendment]], { booking_amendments: [done] });
    const r = await app(db, env)("/cancellations/amend-1/resolve", post({ action: "MARK_REFUNDED_MANUALLY", note: "refunded from Nomod dashboard" }));
    assert.equal(r.status, 200);
    assert.ok(writes.some((w) => w.op === "update" && w.table === "payments"));
  }
});
const booking = { id: "booking-1", tenantId: "tenant", status: "PAYMENT_PENDING", supplier: "MANUAL", userId: null, flightData: {}, totalAmount: "10.00", currency: "INR", pnr: null };
test("Admin shows a PhonePe payment once, from Neon, and never offers the airline retry", async () => {
  const list = await (await app(neon([[booking], [{ bookingId: "booking-1", status: "SUCCESS" }]]).db, gateOn)("/bookings")).json();
  assert.deepEqual(list.phonePe, { "booking-1": "SUCCESS" });
  const row = { id: "PP_ZP1", bookingId: "booking-1", gateway: "PHONEPE", gatewayOrderId: "ZP1", status: "SUCCESS", amount: "10.00", currency: "INR" };
  // loadBooking, then passengers, payments, amendments, support, wallet, exchanges.
  const detail = await (await app(neon([[booking], [], [row], [], [], [], []]).db, gateOn)("/bookings/booking-1")).json();
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.phonePePaid, true);
  assert.equal(detail.paymentConfirmed, false);
  const retry = await app(neon([[booking], [{ gateway: "PHONEPE", status: "SUCCESS" }]]).db, gateOn)("/bookings/booking-1/retry-booking", { method: "POST" });
  assert.equal(retry.status, 409);
  const off = await (await app(neon([[booking]]).db, {})("/bookings")).json();
  assert.equal(off.phonePe, undefined);
});
test("finance reports PhonePe receipts separately from booking revenue", async () => {
  const revenue = [[{ total: "1000" }], [{ total: "0" }], [{ total: "0" }], [{ total: "0" }], [{ total: "0" }], [{ cnt: 1 }], [{ avg: "1000" }]];
  const on = await (await app(neon([...revenue, [{ payments: 2, received: "2500", refunded: "500" }]]).db, { ...gateOn, PHONEPE_ENVIRONMENT: "sandbox" }, "SUPER_ADMIN")("/finance/summary")).json();
  assert.equal(on.totalRevenue, 1000);
  assert.deepEqual(on.phonePe, { environment: "sandbox", payments: 2, receivedMinor: 2500, refundedMinor: 500 });
  const off = await (await app(neon(revenue).db, {}, "SUPER_ADMIN")("/finance/summary")).json();
  assert.equal(off.phonePe, undefined);
});
