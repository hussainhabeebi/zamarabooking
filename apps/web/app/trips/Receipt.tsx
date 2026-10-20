"use client";
import { useEffect, useState } from "react";
import { apiCall, inr } from "../lib/customer-api";

// Printable payment receipt (not a GST tax invoice).
export default function Receipt({ mode, id }: { mode: "customer" | "guest"; id?: string }) {
  const [trip, setTrip] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiCall<{ trip: any }>(mode === "customer" ? `/api/profile/trips/${id}` : "/api/trips/view", { auth: mode })
      .then((d) => setTrip(d.trip)).catch((e) => setError(e.message));
  }, [mode, id]);

  if (error) return <main className="page-container" style={{ padding: 24 }}>{error}</main>;
  if (!trip) return <main className="page-container" style={{ padding: 24 }}>Loading…</main>;

  const fare = trip.totalAmount - trip.serviceFee;
  const refunds = trip.cancellations.filter((c: any) => c.refundStatus === "DONE" && c.refundedAt);
  const seg = trip.itinerary?.segments?.[0];
  return (
    <main className="page-container" style={{ padding: "24px 16px", maxWidth: 720 }}>
      <style>{`@media print { header, .no-print { display: none !important; } body { background: #fff; } }`}</style>
      <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => window.print()} style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 10, padding: "10px 14px", fontWeight: 800, cursor: "pointer" }}>Print / save as PDF</button>
        <a href={mode === "customer" ? `/trips/${trip.id}` : "/trips/guest"} style={{ padding: "10px 14px", fontWeight: 700, color: "#0f172a" }}>Back to booking</a>
      </div>
      <section style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div><h1 style={{ margin: 0, fontSize: 22 }}>Payment receipt</h1><small style={{ color: "#64748b" }}>POOMAS · flypoomas.com</small></div>
          <div style={{ textAlign: "right", fontSize: 13 }}>
            <div>Receipt no. <strong>{trip.id.slice(0, 8).toUpperCase()}</strong></div>
            <div>Date {new Date(trip.createdAt).toLocaleDateString("en-IN")}</div>
            {trip.pnr && <div>PNR <strong>{trip.pnr}</strong></div>}
          </div>
        </div>
        <hr style={{ border: 0, borderTop: "1px solid #e2e8f0", margin: "16px 0" }} />
        <p style={{ margin: "0 0 4px" }}><strong>Billed to:</strong> {trip.passengers[0] ? `${trip.passengers[0].firstName} ${trip.passengers[0].lastName}` : ""}</p>
        <p style={{ margin: "0 0 12px", color: "#475569", fontSize: 14 }}>{trip.contactEmail}{trip.contactPhone ? ` · ${trip.contactPhone}` : ""}</p>
        <p style={{ margin: "0 0 12px", fontSize: 14 }}>
          Flight {trip.origin} → {trip.destination}{seg ? ` · ${seg.airlineName} ${seg.flightNumber}` : ""} · {trip.departureDate ? new Date(trip.departureDate).toLocaleDateString("en-IN") : ""} · {trip.passengers.length} traveller(s)
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            <tr><td style={td}>Air fare (incl. airline taxes)</td><td style={tdR}>{inr(fare, trip.currency)}</td></tr>
            {trip.serviceFee > 0 && <tr><td style={td}>Service fee</td><td style={tdR}>{inr(trip.serviceFee, trip.currency)}</td></tr>}
            <tr><td style={{ ...td, fontWeight: 800 }}>Total paid</td><td style={{ ...tdR, fontWeight: 800 }}>{inr(trip.totalAmount, trip.currency)}</td></tr>
            {refunds.map((r: any) => (
              <tr key={r.id}><td style={td}>Refund ({r.refundMethod === "WALLET" ? "to POOMAS wallet" : r.refundMethod === "NOMOD" ? "to card via Nomod" : "to original payment method"}) {new Date(r.refundedAt).toLocaleDateString("en-IN")}</td><td style={tdR}>−{inr(r.refundAmount ?? 0, trip.currency)}</td></tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#64748b" }}>
          Paid via {trip.payments.filter((p: any) => p.status !== "PENDING").map((p: any) => p.gateway === "WALLET" ? "POOMAS wallet" : p.gateway === "NOMOD" ? "card (Nomod)" : p.gateway).join(", ") || "—"}.
          This is a payment receipt, not a tax invoice.
        </p>
      </section>
    </main>
  );
}

const td: React.CSSProperties = { padding: "8px 0", borderBottom: "1px solid #f1f5f9" };
const tdR: React.CSSProperties = { ...td, textAlign: "right" };
