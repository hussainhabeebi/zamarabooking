// "Paid – Booking failed" (Akbar): who can be refunded / rebooked, and what is blocked afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AKBAR_FAILED_AMENDMENT, akbarPaidBookingFailed, canRecordRebooking, canRefundFailedAkbar, supplierActionBlocked,
} from "../src/lib/akbar-failed-booking.js";

// Booking 226aedc6… shape: paid, CreateItinerary refused (class sold out) before StartPay.
const failed = (over: Record<string, any> = {}, fd: Record<string, any> = {}) => ({
  supplier: "AKBAR", status: "CONFIRMED", pnr: null, totalAmount: "14500.00",
  flightData: {
    akbarBooking: { outcome: "FAILED_BEFORE_PAYMENT", legs: [{ leg: 0, state: "FAILED", errorCode: "ITINERARY_FAILED", message: "CreateItinerary: The requested class of service is sold out., Provider:SG" }] },
    offline: { ticketing: "PENDING" }, ...fd,
  },
  ...over,
});

test("'Paid – Booking failed' only when paid, stopped before paying Akbar, no PNR and no ticket", () => {
  assert.equal(akbarPaidBookingFailed(failed()), true);
  assert.equal(akbarPaidBookingFailed(failed({ status: "PAYMENT_PENDING" })), false);
  assert.equal(akbarPaidBookingFailed(failed({ status: "TICKETED" })), false);
  assert.equal(akbarPaidBookingFailed(failed({ pnr: "ABC123" })), false);
  assert.equal(akbarPaidBookingFailed(failed({ supplier: "TRIPJACK" })), false);
  assert.equal(akbarPaidBookingFailed(failed({}, { offline: { ticketing: "ISSUED" } })), false);
  // StartPay went out (Akbar may have charged / may still book): staff check Akbar first, no refund here.
  assert.equal(akbarPaidBookingFailed(failed({}, { akbarBooking: { outcome: "FAILED", legs: [{ leg: 0, state: "FAILED", paymentSentAt: "x" }] } })), false);
  assert.equal(akbarPaidBookingFailed(failed({}, { akbarBooking: { outcome: "PENDING", legs: [] } })), false);
  assert.equal(akbarPaidBookingFailed(failed({}, { akbarBooking: undefined })), false);
});

test("refund: amount above 0 and at most what was paid; one refund only", () => {
  assert.deepEqual(canRefundFailedAkbar(failed(), [], 14500), { ok: true });
  assert.deepEqual(canRefundFailedAkbar(failed(), [], 9000), { ok: true });           // partial, staff choice
  assert.equal(canRefundFailedAkbar(failed(), [], 0).ok, false);
  assert.equal(canRefundFailedAkbar(failed(), [], Number.NaN).ok, false);
  assert.match((canRefundFailedAkbar(failed(), [], 14500.5) as any).reason, /can't exceed/);
  // Already started (resolution claimed) or a refund row exists in any state.
  assert.match((canRefundFailedAkbar(failed({}, { offline: { ticketing: "PENDING", resolution: { type: "REFUND", at: "t", by: "u", reason: "r" } } }), [], 100) as any).reason, /already started/);
  for (const refundStatus of ["PENDING", "PROCESSING", "DONE", "FAILED", "MANUAL_REQUIRED"]) {
    assert.equal(canRefundFailedAkbar(failed(), [{ type: AKBAR_FAILED_AMENDMENT, status: "SUCCESS", refundStatus }], 100).ok, false, refundStatus);
  }
  assert.equal(canRefundFailedAkbar(failed(), [{ type: "CANCELLATION", status: "SUCCESS", refundStatus: "DONE" }], 100).ok, false);
  // A customer-approved rebooking that could not be done can still be refunded.
  assert.deepEqual(canRefundFailedAkbar(failed({}, { offline: { ticketing: "PENDING", resolution: { type: "REBOOK", at: "t", by: "u", reason: "r" } } }), [], 100), { ok: true });
  // Not a failed paid booking → no refund here.
  assert.equal(canRefundFailedAkbar(failed({ pnr: "ABC123" }), [], 100).ok, false);
});

test("rebooking can be recorded once, never after a refund", () => {
  assert.deepEqual(canRecordRebooking(failed(), []), { ok: true });
  assert.equal(canRecordRebooking(failed({}, { offline: { resolution: { type: "REBOOK", at: "t", by: "u", reason: "r" } } }), []).ok, false);
  assert.equal(canRecordRebooking(failed(), [{ type: AKBAR_FAILED_AMENDMENT, status: "SUCCESS", refundStatus: "FAILED" }]).ok, false);
});

test("after a refund no Akbar API run and no ticket issuing; after a rebooking only 'Issue ticket'", () => {
  const refunded = { offline: { resolution: { type: "REFUND" } } };
  const rebook = { offline: { resolution: { type: "REBOOK" } } };
  assert.match(supplierActionBlocked(refunded, "akbar-api")!, /refund was started/);
  assert.match(supplierActionBlocked(refunded, "issue-ticket")!, /refund was started/);
  assert.match(supplierActionBlocked(rebook, "akbar-api")!, /Issue ticket/);
  assert.equal(supplierActionBlocked(rebook, "issue-ticket"), null);
  assert.equal(supplierActionBlocked({ offline: {} }, "akbar-api"), null);
  assert.equal(supplierActionBlocked(null, "issue-ticket"), null);
});
