// Paid Akbar bookings whose Akbar booking failed before Akbar was paid ("Paid – Booking failed"):
// the customer has paid Zamra, the Akbar API run stopped before StartPay (CreateItinerary refused,
// fare changed, …), no PNR / ticket exists and nothing was paid to Akbar.
//
// Staff resolve it in Admin, once, with one of:
//   REFUND  — refund the customer through the existing refund engine (lib/trips.ts settleRefund):
//             original payment method (customer wallet, agency wallet, Nomod, PhonePe) or MANUAL.
//             The refund is a booking_amendments row of type AKBAR_FAILED_BOOKING (status SUCCESS,
//             refundStatus PENDING → PROCESSING → DONE | FAILED | MANUAL_REQUIRED), so the existing
//             Admin → Cancellations "Retry refund" / "Mark refunded manually" actions apply to it.
//             The booking becomes REFUNDED only when the refund is DONE (settleRefund / manual mark).
//   REBOOK  — record that the customer approved a rebooking that staff arrange on Akbar's portal and
//             ticket with "Issue ticket" (no payment changes here).
// The choice is claimed atomically on the booking row (one conditional UPDATE), so two staff clicks
// can never create two refunds, and further Akbar API runs / ticket issuing are refused after a REFUND.
// Nothing here runs by itself: every step is an explicit staff action.

export const AKBAR_FAILED_AMENDMENT = "AKBAR_FAILED_BOOKING";

export interface FailedBookingResolution {
  type: "REFUND" | "REBOOK";
  by: string | null;          // staff user id
  at: string;                 // ISO time
  reason: string;
  amount?: number;            // REFUND: amount refunded (booking currency)
  amendmentId?: string;       // REFUND: booking_amendments row
}

type BookingLike = {
  supplier: string; status: string; pnr?: string | null; totalAmount: string | number;
  flightData?: Record<string, any> | null;
};
type AmendmentLike = { type: string; status: string; refundStatus: string };

export const resolutionOf = (fd: Record<string, any> | null | undefined): FailedBookingResolution | null =>
  (fd?.offline?.resolution && typeof fd.offline.resolution === "object" ? fd.offline.resolution as FailedBookingResolution : null);

// "Paid – Booking failed": paid (CONFIRMED), Akbar API stopped before paying Akbar on every leg,
// no PNR, no ticket issued.
export function akbarPaidBookingFailed(b: BookingLike): boolean {
  if (b.supplier !== "AKBAR" || b.status !== "CONFIRMED" || b.pnr) return false;
  const fd = b.flightData ?? {};
  const state = fd.akbarBooking as { outcome?: string; legs?: { paymentSentAt?: string }[] } | undefined;
  if (state?.outcome !== "FAILED_BEFORE_PAYMENT") return false;
  if ((state.legs ?? []).some((l) => l.paymentSentAt)) return false;   // anything sent to Akbar: staff check Akbar first
  return fd.offline?.ticketing !== "ISSUED";
}

export type Check = { ok: true } | { ok: false; reason: string };

export function canRefundFailedAkbar(b: BookingLike, amendments: AmendmentLike[], amount: number): Check {
  if (!akbarPaidBookingFailed(b)) return { ok: false, reason: "Only paid Akbar bookings whose Akbar booking failed before payment (no PNR, no ticket) can be refunded here." };
  const r = resolutionOf(b.flightData);
  if (r?.type === "REFUND") return { ok: false, reason: "A refund was already started for this booking — see Admin → Cancellations." };
  if (amendments.some((a) => a.type === AKBAR_FAILED_AMENDMENT || (a.status === "SUCCESS" && a.refundStatus !== "PENDING"))) {
    return { ok: false, reason: "A refund already exists for this booking." };
  }
  const paid = Number(b.totalAmount);
  if (!(Number.isFinite(amount) && amount > 0)) return { ok: false, reason: "Enter a refund amount above 0." };
  if (amount > paid + 0.001) return { ok: false, reason: `The refund can't exceed the amount paid (${paid.toFixed(2)}).` };
  return { ok: true };
}

export function canRecordRebooking(b: BookingLike, amendments: AmendmentLike[]): Check {
  if (!akbarPaidBookingFailed(b)) return { ok: false, reason: "Only paid Akbar bookings whose Akbar booking failed before payment can be rebooked here." };
  if (resolutionOf(b.flightData)) return { ok: false, reason: `Already resolved: ${resolutionOf(b.flightData)!.type}.` };
  if (amendments.some((a) => a.type === AKBAR_FAILED_AMENDMENT)) return { ok: false, reason: "A refund exists for this booking." };
  return { ok: true };
}

// Akbar API runs and "Issue ticket" are refused once a refund was started (and API runs once a
// customer-approved rebooking is being arranged by staff on Akbar's portal).
export function supplierActionBlocked(fd: Record<string, any> | null | undefined, action: "akbar-api" | "issue-ticket"): string | null {
  const r = resolutionOf(fd);
  if (!r) return null;
  if (r.type === "REFUND") return "A refund was started for this booking, so it can't be booked or ticketed any more.";
  if (action === "akbar-api") return "Staff are arranging a customer-approved rebooking on Akbar's portal; issue the ticket with \"Issue ticket\" instead of the Akbar API.";
  return null;
}
