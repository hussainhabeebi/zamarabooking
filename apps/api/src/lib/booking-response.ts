import type { BookResult } from "@poomas/suppliers";

// HTTP success means the request was accepted, not necessarily ticketed.
export function normalizeBookingResponse(raw: unknown, sessionId: string): Omit<BookResult, "status"> & { status: BookResult["status"] | "PENDING" } {
  const root = raw as any;
  const data = root?.data ?? root?.result ?? root;
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

  // TripJack /oms/v1/air/book response wraps in order{} with status = "SUCCESS"/"ON_HOLD"/"FAILED"
  const order = data?.order ?? data;
  const orderStatus = text(order?.status).toUpperCase();
  const orderSuccess = orderStatus === "SUCCESS" || orderStatus === "ON_HOLD";

  // Legacy: status.success boolean (proxy responses)
  const apiStatus = data?.status ?? root?.status;
  const successFlag = apiStatus?.success;

  const bookingRef = text(order?.bookingId) || text(data?.bookingId) || text(root?.bookingId);

  // Throw only when there is genuinely no way to establish the outcome.
  if (!orderStatus && successFlag == null && !bookingRef) {
    console.error("[book-normalize] Unrecognized booking response", JSON.stringify(root).slice(0, 500));
    throw new Error("Booking response did not establish an outcome");
  }

  const legacySuccess = successFlag === true || successFlag === "true";
  const success = orderSuccess || (legacySuccess && !(root?.errors?.length || data?.errors?.length));
  const resolvedRef = bookingRef || (success ? sessionId : "");

  // PNR: travellerInfos[0].pnrDetails is an object { "DEP-ARR": "pnr" }
  const travellers = Array.isArray(data?.travellerInfos) ? data.travellerInfos : [];
  const pnrMap = travellers[0]?.pnrDetails;
  const pnr = (pnrMap && typeof pnrMap === "object" ? Object.values(pnrMap)[0] : null)
    ?? text(data?.pnr) ?? text(data?.pnrDetails) ?? text(root?.pnrDetails);

  const failed = ["FAILED", "CANCELLED", "REJECTED", "ABORTED"].includes(orderStatus)
    || (successFlag === false && !bookingRef);
  return {
    success: success && !failed && !!resolvedRef,
    bookingRef: resolvedRef,
    pnr: typeof pnr === "string" ? pnr : "",
    status: !success || failed ? "FAILED"
      : pnr && orderStatus === "SUCCESS" ? "TICKETED"
      : pnr ? "CONFIRMED" : "PENDING",
    ticketNumbers: [],
    raw,
  };
}
