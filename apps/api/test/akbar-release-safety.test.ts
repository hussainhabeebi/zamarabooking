import test from "node:test";
import assert from "node:assert/strict";
import { recordAkbarPaymentPending } from "../src/queue-consumer.js";
import { akbarEvidencePack } from "../src/lib/akbar-evidence-export.js";
import { akbarConfirmation } from "../src/lib/akbar-evidence.js";

const booking = { id: "b", tenantId: "t", supplier: "AKBAR", status: "PAYMENT_PENDING", flightData: { searchId: "s" } };
const payment = { orderId: "order", gatewayPaymentId: "payment", amount: 100 };
const env = { TENANT_CACHE_KV: { get: async () => [], put: async () => {} } };

test("Akbar payment is recorded without supplier confirmation or external side effects; retries stay pending", async () => {
  const writes: any[] = [];
  const db = { update: () => ({ set: (value: any) => ({ where: async () => { writes.push(value); } }) }) };
  for (let i = 0; i < 2; i++) await recordAkbarPaymentPending(db as any, env as any, payment as any, booking as any);
  assert.deepEqual(writes.map((w) => w.status), ["SUCCESS", "PAYMENT_PENDING", "SUCCESS", "PAYMENT_PENDING"]);
  assert.equal(writes[1].flightData.offline.paymentRecorded, true);
  assert.equal(writes[1].flightData.offline.supplierConfirmation, "PENDING");
  assert.equal(akbarConfirmation({ ...booking, flightData: writes[1].flightData }).label, "Paid · supplier confirmation pending");
});
test("a failed booking write can retry without a supplier booking or false confirmation", async () => {
  let fail = true; const writes: any[] = [];
  const db = { update: () => ({ set: (value: any) => ({ where: async () => {
    if (value.flightData && fail) { fail = false; throw new Error("write failed"); } writes.push(value);
  } }) }) };
  await assert.rejects(recordAkbarPaymentPending(db as any, env as any, payment as any, booking as any));
  await recordAkbarPaymentPending(db as any, env as any, payment as any, booking as any);
  assert.equal(writes.at(-1).status, "PAYMENT_PENDING");
  assert.equal(writes.some((w) => w.status === "CONFIRMED"), false);
});
test("Akbar payment recorder refuses other suppliers or terminal bookings", async () => {
  for (const bad of [{ ...booking, supplier: "TRIPJACK" }, { ...booking, status: "TICKETED" }]) {
    await assert.rejects(recordAkbarPaymentPending({} as any, env as any, payment as any, bad as any), /pending booking required/);
  }
});
const row = { id: "exchange", tenantId: "t", supplier: "AKBAR", bookingId: "b", searchId: null,
  endpoint: "/flights/CreateItinerary", httpStatus: 200, durationMs: 3, startedAt: new Date("2026-10-28T12:00:00Z"),
  requestKey: "api-logs/t/request.json", responseKey: "api-logs/t/response.json" };

test("Akbar evidence export includes only stored sanitized content and never fabricates missing calls", async () => {
  // Synthetic local test input, never a certification submission.
  const bucket = { get: async (key: string) => key.endsWith("request.json") ? { size: 40, text: async () => '{"headers":{"Authorization":"secret"}}' } : { size: 45, text: async () => '{"TransactionId":"12345678901234567890","PNR":"ABC123"}' } };
  const files = await akbarEvidencePack(bucket as any, booking, [row]);
  assert.equal(files.length, 3);
  const manifest = JSON.parse(new TextDecoder().decode(files[0].data));
  assert.equal(manifest.certificationReady, false);
  assert.equal(manifest.environment, "UNVERIFIED");
  assert.equal(manifest.exchanges[0].request.present, true);
  const body = files.map((f) => new TextDecoder().decode(f.data)).join("");
  assert.match(body, /12345678901234567890/); assert.match(body, /ABC123/);
  assert.doesNotMatch(body, /secret|tripjack/);
  const incomplete = await akbarEvidencePack({ get: async () => null } as any, booking, [{ ...row, responseKey: null }]);
  assert.equal(incomplete.length, 1); // manifest only, no invented request/response
  const m = JSON.parse(new TextDecoder().decode(incomplete[0].data));
  assert.equal(m.exchanges[0].request.present, false); assert.equal(m.exchanges[0].response.present, false);
});
test("evidence archive rejects cross-tenant/supplier/link/storage paths and oversized inputs", async () => {
  for (const bad of [{ ...row, tenantId: "other" }, { ...row, supplier: "TRIPJACK" }, { ...row, bookingId: "other" }, { ...row, requestKey: "api-logs/other/secret.json" }]) {
    await assert.rejects(akbarEvidencePack({} as any, booking, [bad]));
  }
  await assert.rejects(akbarEvidencePack({} as any, booking, Array(501).fill(row)));
  await assert.rejects(akbarEvidencePack({ get: async () => ({ size: 2_097_153 }) } as any, booking, [row]));
});
