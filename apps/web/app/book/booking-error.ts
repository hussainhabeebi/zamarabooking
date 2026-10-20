export function bookingError(data: any, status: number): string {
  const messages: Record<string, string> = {
    FARE_REVIEW_FAILED: "Availability could not be checked. Your details are saved on this page; please retry shortly.",
    BOOKING_UNAVAILABLE: "Booking is temporarily unavailable. Your details are still here.",
    BOOKING_REJECTED: "The airline supplier did not accept this booking.",
    BOOKING_STATUS_UNKNOWN: "We haven't received the booking result. Do not submit again; contact support to check its status.",
  };
  const diagnostics: Record<string, string> = {
    REVIEW_ROUTE_UNAVAILABLE: "The booking connection is unavailable. Please contact support.",
    REVIEW_AUTH_FAILED: "The booking connection could not be authorised. Please contact support.",
    REVIEW_TIMEOUT: "The availability check timed out. No booking was submitted; you can retry.",
    REVIEW_INVALID_RESPONSE: "The supplier did not return a booking session. Please contact support.",
  };
  const base = messages[data?.errorCode]
    ? diagnostics[data?.diagnosticCode] ?? messages[data.errorCode]
    : status === 400
      // Show the actual reason: our own check (error) or the first validation issue.
      ? (typeof data?.error === "string" && data.error.trim() ? data.error.trim()
        : data?.error?.issues?.[0]?.message ? `Please check your details: ${data.error.issues[0].message}.`
        : "Please check traveller names, contact details and travel dates.")
    : "We couldn't receive a valid booking result. Please contact support before trying again.";
  const supplier = typeof data?.supplierMessage === "string" && data.supplierMessage.trim()
    ? ` Supplier: ${data.supplierMessage.trim()}.`
    : "";
  const ref = typeof data?.requestId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(data.requestId) ? ` Reference: ${data.requestId}.` : "";
  return base + supplier + ref;
}
