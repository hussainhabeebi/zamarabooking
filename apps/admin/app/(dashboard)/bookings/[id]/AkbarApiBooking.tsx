"use client";
import { useState } from "react";
import { API, apiHeaders } from "../../../../lib/api";

type Leg = { leg: number; state: string; transactionId?: number; pnrs?: string[]; tickets?: string[]; pricedNetAmount?: number; itineraryNetAmount?: number; paymentSentAt?: string; errorCode?: string; message?: string };
type State = { legs: Leg[]; outcome?: string; runs?: number; finishedAt?: string };

// Akbar API booking (Admin → Integrations → Akbar "API booking" MANUAL / AUTO). Book runs
// SmartPricer → … → CreateItinerary → StartPay; Refresh only asks Akbar for the status of
// legs already paid. StartPay is never sent twice for a leg (API side).
export function AkbarApiBooking({ booking, onDone }: {
  booking: { id: string; supplier: string; status: string; flightData?: Record<string, any> | null };
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (booking.supplier !== "AKBAR") return null;
  const state = booking.flightData?.akbarBooking as State | undefined;
  const paid = state?.legs?.some((l) => l.paymentSentAt);
  const canBook = booking.status === "CONFIRMED" && booking.flightData?.offline?.ticketing !== "ISSUED";

  async function run(action: "book" | "refresh") {
    if (action === "book" && !confirm("Book this paid booking on the Akbar API now? This pays Akbar from the deposit account.")) return;
    setBusy(action); setError("");
    try {
      const res = await fetch(`${API}/api/admin/bookings/${booking.id}/akbar/${action}`, { method: "POST", headers: apiHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok && !d.outcome) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      onDone(d.outcome === "TICKETED" ? "Akbar confirmed the booking — PNR saved and the e-ticket emailed." : `Akbar API: ${d.outcome ?? "no change"}${d.error ? ` — ${d.error}` : ""}`);
    } catch (err: any) { setError(err.message); } finally { setBusy(""); }
  }

  return (
    <div style={box}>
      <div style={{ fontWeight: 800, color: "#fbbf24", fontSize: 14, marginBottom: 6 }}>Akbar API booking{state?.outcome ? ` — ${state.outcome}` : ""}</div>
      {state?.legs?.length ? (
        <table style={{ width: "100%", fontSize: 12, color: "#cbd5e1", borderCollapse: "collapse" }}>
          <thead><tr style={{ color: "#94a3b8", textAlign: "left" }}><th>Leg</th><th>State</th><th>Transaction</th><th>Net ₹</th><th>PNR</th><th>Tickets</th><th>Note</th></tr></thead>
          <tbody>{state.legs.map((l) => (
            <tr key={l.leg}><td>{l.leg + 1}</td><td>{l.state}</td><td>{l.transactionId ?? "—"}</td><td>{l.itineraryNetAmount ?? l.pricedNetAmount ?? "—"}</td>
              <td>{l.pnrs?.join(", ") || "—"}</td><td>{l.tickets?.join(", ") || "—"}</td><td>{l.errorCode ? `${l.errorCode}: ${l.message ?? ""}` : l.message ?? ""}</td></tr>
          ))}</tbody>
        </table>
      ) : <p style={{ color: "#94a3b8", fontSize: 13, margin: 0 }}>Not booked on the Akbar API yet.</p>}
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {canBook && <button disabled={!!busy} onClick={() => run("book")} style={btn}>{busy === "book" ? "Booking on Akbar…" : paid ? "Continue Akbar booking" : "Book on Akbar API"}</button>}
        {paid && <button disabled={!!busy} onClick={() => run("refresh")} style={{ ...btn, background: "#0f172a", border: "1px solid #334155" }}>{busy === "refresh" ? "Checking…" : "Refresh from Akbar"}</button>}
      </div>
    </div>
  );
}

const box: React.CSSProperties = { border: "1px solid #a16207", borderRadius: 10, padding: 14, margin: "10px 0", background: "rgba(245,158,11,.06)" };
const btn: React.CSSProperties = { background: "#0D4B96", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
