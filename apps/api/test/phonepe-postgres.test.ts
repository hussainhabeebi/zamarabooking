import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@zamrabooking/db/schema";
import {
  PhonePeDbStore,
  claimCheckoutGateway,
  type Order,
} from "../src/lib/phonepe/store.js";

// Hard boundary: a disposable loopback-only database, never a production DSN.
const raw = process.env.PHONEPE_TEST_DATABASE_URL;
if (!raw || process.env.PHONEPE_TEST_DISPOSABLE !== "true")
  throw new Error(
    "Explicit disposable PostgreSQL fixture configuration required",
  );
const url = new URL(raw);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.pathname !== "/phonepe_test" ||
  url.username !== "phonepe_test"
)
  throw new Error("Refusing non-local or non-test database");
const pool = new Pool({ connectionString: raw, max: 24 });
const namespace = `phonepe_ci_${crypto.randomUUID().replaceAll("-", "")}`;
assert.match(namespace, /^phonepe_ci_[a-f0-9]+$/);
let serial = 0;
before(async () => {
  const c = await pool.connect();
  try {
    await c.query(`CREATE SCHEMA "${namespace}"`);
    await c.query(`SET search_path TO "${namespace}"`);
    await c.query(
      await readFile(
        new URL("./phonepe/postgres-fixture.sql", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    c.release();
  }
});
after(async () => {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  } finally {
    await pool.end();
  }
});
async function query(text: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(`SET search_path TO "${namespace}"`);
    return await c.query(text, params);
  } finally {
    c.release();
  }
}
async function withStore<T>(fn: (s: PhonePeDbStore, db: any) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query(`SET search_path TO "${namespace}"`);
    const db: any = drizzle(c, { schema });
    // The production Neon HTTP batch is a single non-interactive transaction.
    // Execute the same production Drizzle queries on one dedicated PG session.
    db.batch = async (queries: Promise<unknown>[]) => {
      await c.query("BEGIN");
      try {
        const results = [];
        for (const [i, q] of queries.entries()) {
          results.push(await q);
          if (i === 0) await c.query("SELECT pg_sleep(0.01)"); // encourage overlapping transactions
        }
        await c.query("COMMIT");
        return results;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    };
    return await fn(new PhonePeDbStore(db), db);
  } finally {
    c.release();
  }
}
async function draft(amount = 1000): Promise<Order> {
  const id = `fixture_${++serial}`;
  await query(
    "INSERT INTO bookings(id,tenant_id) VALUES($1,'fixture-tenant')",
    [id],
  );
  return {
    merchantOrderId: `ZP_${id}`,
    tenantId: "fixture-tenant",
    bookingId: id,
    paymentId: `PP_${id}`,
    environment: "sandbox",
    accountKey: "fixture-account",
    amountMinor: amount,
    refundReservedMinor: 0,
    state: "INITIATED",
    providerOrderId: null,
    transactionId: null,
    checkoutUrl: null,
    expiresAt: null,
    updatedAt: new Date(),
  };
}
async function paid(amount = 1000) {
  const o = await draft(amount);
  await withStore(async (s) => {
    await s.reserve(o);
    await s.applyOrder(o, {
      state: "COMPLETED",
      orderId: `provider_${o.bookingId}`,
      transactionId: `transaction_${o.bookingId}`,
    });
  });
  return o;
}
test("16 concurrent checkout reservations create one ledger/order and exactly one owner", async () => {
  const o = await draft();
  const rows = await Promise.all(
    Array.from({ length: 16 }, () => withStore((s) => s.reserve(o))),
  );
  assert.equal(rows.filter((r) => r.owner).length, 1);
  assert.equal(
    (
      await query("SELECT count(*)::int n FROM payments WHERE id=$1", [
        o.paymentId,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM phonepe_orders WHERE merchant_order_id=$1",
        [o.merchantOrderId],
      )
    ).rows[0].n,
    1,
  );
});
test("failed order insertion rolls back the ledger reservation atomically", async () => {
  const o = await draft();
  o.tenantId = "missing-tenant";
  await assert.rejects(withStore((s) => s.reserve(o)));
  assert.equal(
    (
      await query("SELECT count(*)::int n FROM payments WHERE id=$1", [
        o.paymentId,
      ])
    ).rows[0].n,
    0,
  );
});
test("competing hosted/wallet gateways cannot both claim a booking", async () => {
  const o = await draft();
  const gateways = ["PHONEPE", "NOMOD", "RAZORPAY", "WALLET"];
  const rows = await Promise.allSettled(
    Array.from({ length: 16 }, (_, i) =>
      withStore(async (_, db) => {
        await claimCheckoutGateway(
          db,
          o.tenantId,
          o.bookingId,
          gateways[i % 4],
        );
        return gateways[i % 4];
      }),
    ),
  );
  const winners = rows.filter(
    (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
  );
  assert.equal(new Set(winners.map((r) => r.value)).size, 1);
  assert.equal(winners.length, 4);
});
test("20 duplicate full-refund reservations have exactly one owner and one debit", async () => {
  const o = await paid();
  const rows = await Promise.all(
    Array.from({ length: 20 }, () =>
      withStore((s) => s.reserveRefund(o, `refund_${o.bookingId}`, 1000)),
    ),
  );
  assert.equal(rows.filter((r) => r.owner).length, 1);
  assert.equal(
    (
      await query(
        "SELECT refund_reserved_minor FROM phonepe_orders WHERE merchant_order_id=$1",
        [o.merchantOrderId],
      )
    ).rows[0].refund_reserved_minor,
    1000,
  );
});
test("competing partial refunds cannot reserve beyond captured funds", async () => {
  const o = await paid();
  const rows = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      withStore((s) => s.reserveRefund(o, `partial_${o.bookingId}_${i}`, 400)),
    ),
  );
  assert.equal(rows.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    (
      await query(
        "SELECT refund_reserved_minor FROM phonepe_orders WHERE merchant_order_id=$1",
        [o.merchantOrderId],
      )
    ).rows[0].refund_reserved_minor,
    800,
  );
});
test("concurrent refund completions and stale events retain the full aggregate", async () => {
  for (let i = 0; i < 6; i++) {
    const o = await paid();
    const a = await withStore((s) =>
      s.reserveRefund(o, `a_${o.bookingId}`, 400),
    );
    const b = await withStore((s) =>
      s.reserveRefund(o, `b_${o.bookingId}`, 600),
    );
    await Promise.all([
      withStore((s) => s.applyRefund(a.refund, "COMPLETED", "provider_a")),
      withStore((s) => s.applyRefund(b.refund, "COMPLETED", "provider_b")),
    ]);
    await Promise.all([
      withStore((s) => s.applyRefund(a.refund, "FAILED", null)),
      withStore((s) => s.applyRefund(b.refund, "PENDING", null)),
    ]);
    const ledger = (
      await query("SELECT status,refunded_amount FROM payments WHERE id=$1", [
        o.paymentId,
      ])
    ).rows[0];
    assert.equal(ledger.status, "REFUNDED");
    assert.equal(ledger.refunded_amount, "10.00");
    assert.equal(
      (await query("SELECT status FROM bookings WHERE id=$1", [o.bookingId]))
        .rows[0].status,
      "PAYMENT_PENDING",
    );
  }
});
test("mixed duplicate payment events never downgrade success or confirm a booking", async () => {
  const o = await draft();
  await withStore((s) => s.reserve(o));
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      withStore((s) =>
        s.applyOrder(o, {
          state: ["PENDING", "FAILED", "COMPLETED"][i % 3],
          orderId: "provider_order",
          transactionId: i % 3 === 2 ? "provider_transaction" : undefined,
        }),
      ),
    ),
  );
  const ledger = (
    await query("SELECT status FROM payments WHERE id=$1", [o.paymentId])
  ).rows[0];
  assert.equal(ledger.status, "SUCCESS");
  const booking = (
    await query("SELECT status,pnr FROM bookings WHERE id=$1", [o.bookingId])
  ).rows[0];
  assert.equal(booking.status, "PAYMENT_PENDING");
  assert.equal(booking.pnr, null);
});
test("large refund limits reject safely without integer overflow", async () => {
  const o = await paid(2147483647);
  await withStore((s) =>
    s.reserveRefund(o, `large_${o.bookingId}`, 1500000000),
  );
  await assert.rejects(
    withStore((s) => s.reserveRefund(o, `excess_${o.bookingId}`, 1500000000)),
    /REFUND_LIMIT_EXCEEDED/,
  );
});
test("database constraints prevent cross-tenant refund links and ledger reuse", async () => {
  const o = await paid();
  await assert.rejects(
    query(
      "INSERT INTO phonepe_refunds(merchant_refund_id,merchant_order_id,tenant_id,amount_minor) VALUES($1,$2,'other-fixture-tenant',100)",
      [`cross_${o.bookingId}`, o.merchantOrderId],
    ),
  );
  const another = await draft();
  another.paymentId = o.paymentId;
  await assert.rejects(withStore((s) => s.reserve(another)));
});
