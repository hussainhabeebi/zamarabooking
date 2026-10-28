// Evidence helpers only: no transport, booking, payment or supplier calls.
const sensitive = /^(authorization|cookie|setcookie|password|apikey|key|gatewaykey|xzamragatewaykey|token|tokenid|accesstoken|merchantid|clientid|agentcode|browserkey|firstname|lastname|fullname|name|email|contactemail|phone|contactphone|mobile|passport|passportnumber|documentnumber|dob|dateofbirth|address|pan|pannumber|pax|passengers|travellers|traveler|traveller|contact|gstinfo|emergencycontact|message|errormessage|error|description)$/i;
export function redactAkbarJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), (key, value) =>
      sensitive.test(key.replace(/[^a-z0-9]/gi, "")) ? "[REDACTED]" : value, 2);
  } catch {
    // Unstructured errors can contain credentials or passenger details. Never export them.
    return JSON.stringify({ omitted: "Non-JSON content withheld; review securely at source." });
  }
}

export function akbarConfirmation(booking: { status: string; pnr?: string | null; supplierBookingRef?: string | null; flightData?: unknown }) {
  // Legacy staff-entered references and payment status are NOT API confirmation evidence.
  const fd = booking.flightData as { offline?: { paymentRecorded?: boolean } } | null;
  return {
    supplierConfirmed: false,
    label: ["CONFIRMED", "TICKETED"].includes(booking.status)
      ? "Supplier confirmation unverified" : fd?.offline?.paymentRecorded
        ? "Paid · supplier confirmation pending" : booking.status,
    transactionId: null,
    reason: "Akbar CreateItinerary and supplier confirmation capture are not implemented. Payment or a manual reference does not establish an API booking.",
  };
}
