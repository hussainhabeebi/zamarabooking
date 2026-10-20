"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { saveGuestToken } from "../../lib/customer-api";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

export default function NomodPaymentResultPage() {
  return (
    <Suspense fallback={<main style={{ minHeight: "100vh", background: "#f8fafc", display: "grid", placeItems: "center" }}>Confirming payment…</main>}>
      <NomodPaymentResult />
    </Suspense>
  );
}

function NomodPaymentResult() {
  const params = useSearchParams();
  const bookingId = params.get("bookingId") ?? "";
  const token = params.get("token") ?? "";
  const result = params.get("result");
  const [status, setStatus] = useState<"checking" | "success" | "pending" | "failed">(
    result === "failed" ? "failed" : "checking",
  );
  // After payment: the airline booking is made in the background; follow it to the PNR.
  const [booking, setBooking] = useState<{ status?: string; pnr?: string | null; hasAccount?: boolean } | null>(null);

  useEffect(() => {
    if (!bookingId || !token || result === "failed") return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      attempts += 1;
      try {
        const res = await fetch(`${API}/api/payments/${encodeURIComponent(bookingId)}`, {
          headers: { "x-tenant-slug": "poomas", "X-Checkout-Token": token },
          cache: "no-store",
        });
        const data = await res.json() as { payment?: { status?: string }; tripToken?: string; booking?: { status?: string; pnr?: string | null; hasAccount?: boolean } };
        if (data.booking) setBooking(data.booking);
        // Paid: continue on the itinerary confirmation page, which waits for the
        // airline booking and downloads the itinerary.
        if (data.payment?.status === "SUCCESS" && data.tripToken) {
          setStatus("success");
          saveGuestToken(data.tripToken);
          window.location.replace("/trips/itinerary");
          return;
        }
        const ticketingDone = ["CONFIRMED", "TICKETED", "PAYMENT_FAILED", "REFUNDED", "CANCELLED"].includes(data.booking?.status ?? "");
        if (data.payment?.status === "SUCCESS" || data.payment?.status === "REFUNDED") {
          setStatus("success");
          // Keep following the booking for ~2 minutes until ticketing finishes.
          if (!ticketingDone && attempts < 60) timer = setTimeout(check, 3000);
          return;
        }
      } catch {}
      if (attempts < 20) {
        setStatus("pending");
        timer = setTimeout(check, 2500);
      } else {
        setStatus("pending");
      }
    }

    check();
    return () => clearTimeout(timer);
  }, [bookingId, token, result]);

  const successful = status === "success";
  const failed = status === "failed";
  const ticketed = ["CONFIRMED", "TICKETED"].includes(booking?.status ?? "");
  const bookingFailed = successful && booking?.status === "PAYMENT_FAILED";
  const tripHref = booking?.hasAccount ? `/trips/${bookingId}` : "/trips/find";

  return (
    <main style={{ minHeight: "100vh", background: "#f8fafc", display: "grid", placeItems: "center", padding: 20 }}>
      <section style={{ width: "100%", maxWidth: 480, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 18, padding: 28, textAlign: "center", boxShadow: "0 18px 45px rgba(15,23,42,.09)" }}>
        <div style={{ width: 64, height: 64, display: "grid", placeItems: "center", margin: "0 auto 18px", borderRadius: "50%", background: successful ? "#dcfce7" : failed ? "#fee2e2" : "#ede9fe", fontSize: 28 }}>
          {successful ? "✓" : failed ? "×" : "…"}
        </div>
        <h1 style={{ margin: "0 0 9px", color: "#0f172a", fontSize: 24 }}>
          {ticketed ? "Booking confirmed" : bookingFailed ? "Booking could not be completed" : successful ? "Payment confirmed" : failed ? "Payment was not completed" : "Confirming your payment"}
        </h1>
        <p style={{ margin: "0 0 22px", color: "#64748b", lineHeight: 1.55, fontSize: 14 }}>
          {ticketed
            ? `Your ticket is issued${booking?.pnr ? ` — PNR ${booking.pnr}` : ""}. The e-ticket is on its way to your email.`
            : bookingFailed
              ? "The airline couldn't confirm this booking. Your payment is being refunded automatically (wallet payments return to your wallet)."
            : successful
            ? "Your payment has been received. We're confirming your seat with the airline — this usually takes under a minute."
            : failed
              ? "No charge was confirmed. You can return to checkout and try again."
              : "Nomod has returned you to FlyPoomas. Keep this page open while we verify the payment securely."}
        </p>
        {ticketed || bookingFailed ? (
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <a href={tripHref} style={button}>View booking</a>
            <a href="/" style={{ ...button, background: "#fff", color: "#0f172a", border: "1.5px solid #e2e8f0" }}>Back to home</a>
          </div>
        ) : successful ? (
          <a href="/" style={button}>Back to home</a>
        ) : (
          <a href={token ? `/checkout/${token}` : "/"} style={button}>{failed ? "Try payment again" : "Return to checkout"}</a>
        )}
        <div style={{ marginTop: 18, color: "#94a3b8", fontSize: 11 }}>Booking reference: {bookingId.slice(0, 12) || "Unavailable"}</div>
      </section>
    </main>
  );
}

const button: React.CSSProperties = {
  display: "inline-block", background: "#e31e24", color: "#fff", textDecoration: "none",
  borderRadius: 10, padding: "12px 20px", fontWeight: 800, fontSize: 14,
};
