"use client";
import { useState } from "react";
import { API, apiHeaders } from "../../../../lib/api";

type Leg = { leg: number; state: string; transactionId?: number; pnrs?: string[]; tickets?: string[]; pricedNetAmount?: number; itineraryNetAmount?: number; paymentSentAt?: string; errorCode?: string; message?: string };
type State = { legs: Leg[]; outcome?: string; runs?: number; finishedAt?: string };

// Akbar API booking (Admin → Integrations → Akbar "API booking" MANUAL / AUTO). Book runs
// SmartPricer → … → CreateItinerary → StartPay; Refresh only asks Akbar for the status of
// legs already paid. StartPay is never sent twice for a leg (API side).
type Refund = { id: string; type: string; refundStatus: string; refundMethod: string; refundAmount: string | null; refundReference: string | null; refundError: string | null; refundedAt: string | null; currency: string };
type Resolution = { type: "REFUND" | "REBOOK"; by: string | null; at: string; reason: string; amount?: number; amendmentId?: string };

export function AkbarApiBooking({ booking, refunds = [], onDone }: {
  booking: { id: string; supplier: string; status: string; pnr?: string | null; totalAmount?: string | number; currency?: string; flightData?: Record<string, any> | null };
  refunds?: Refund[];
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState<"" | "refund" | "rebook">("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(String(booking.totalAmount ?? ""));
  if (booking.supplier !== "AKBAR") return null;
  const state = booking.flightData?.akbarBooking as State | undefined;
  const paid = state?.legs?.some((l) => l.paymentSentAt);
  const resolution = booking.flightData?.offline?.resolution as Resolution | undefined;
  const refund = refunds.find((r) => r.type === "AKBAR_FAILED_BOOKING");
  // "Paid – Booking failed": paid, Akbar run stopped before paying Akbar on every leg, no PNR / ticket.
  const failedPaid = booking.status === "CONFIRMED" && !booking.pnr && state?.outcome === "FAILED_BEFORE_PAYMENT" && !paid
    && booking.flightData?.offline?.ticketing !== "ISSUED";
  const canBook = booking.status === "CONFIRMED" && booking.flightData?.offline?.ticketing !== "ISSUED" && !resolution;

  async function resolve(kind: "refund" | "rebook") {
    const body = kind === "refund" ? { reason, amount: Number(amount) } : { note: reason };
    const what = kind === "refund" ? `Refund ${amount} ${booking.currency ?? ""} to the customer's original payment method now?` : "Record that the customer approved this rebooking?";
    if (!confirm(what)) return;
    setBusy(kind); setError("");
    try {
      const res = await fetch(`${API}/api/admin/bookings/${booking.id}/akbar/${kind}`, { method: "POST", headers: { ...apiHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      setForm(""); setReason("");
      onDone(kind === "refund"
        ? d.refund.status === "DONE" ? `Refund paid via ${d.refund.method} (${d.refund.reference ?? ""}) — booking REFUNDED.` : `Refund ${d.refund.status}${d.refund.error ? `: ${d.refund.error}` : ""} — finish it in Cancellations. The booking stays paid until the refund is confirmed.`
        : "Rebooking recorded — book it on Akbar's portal, then use Issue ticket.");
    } catch (err: any) { setError(err.message); } finally { setBusy(""); }
  }

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
      {failedPaid && !resolution && (
        <div style={{ marginTop: 10, border: "1px solid #b91c1c", borderRadius: 8, padding: 10, background: "rgba(239,68,68,.08)" }}>
          <div style={{ fontWeight: 800, color: "#f87171" }}>Paid – Booking failed</div>
          <div style={{ color: "#cbd5e1", fontSize: 13, margin: "4px 0 8px" }}>The customer has paid; Akbar refused the booking before it was paid on Akbar (no PNR, no ticket). Refund the customer, or rebook only with the customer&apos;s approval. The customer keeps seeing &quot;Ticket being issued&quot; until a refund is confirmed.</div>
          {!form && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setForm("refund")} style={{ ...btn, background: "#b91c1c" }}>Refund customer…</button>
            <button onClick={() => setForm("rebook")} style={{ ...btn, background: "#0f172a", border: "1px solid #334155" }}>Record customer-approved rebooking…</button>
          </div>}
          {form && <div style={{ display: "grid", gap: 6, maxWidth: 520 }}>
            {form === "refund" && <label style={lbl}>Refund amount ({booking.currency}) — to the original payment method
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} /></label>}
            <label style={lbl}>{form === "refund" ? "Reason (saved with the refund)" : "What the customer approved (flight, class, price difference)"}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={inp} /></label>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={!!busy || reason.trim().length < 5 || (form === "refund" && !(Number(amount) > 0))} onClick={() => resolve(form)} style={{ ...btn, background: form === "refund" ? "#b91c1c" : "#0D4B96" }}>
                {busy ? "Working…" : form === "refund" ? "Refund now" : "Record rebooking"}</button>
              <button onClick={() => { setForm(""); setReason(""); }} style={{ ...btn, background: "#0f172a", border: "1px solid #334155" }}>Cancel</button>
            </div>
          </div>}
        </div>
      )}
      {resolution && (
        <div style={{ marginTop: 10, color: "#cbd5e1", fontSize: 13, border: "1px solid #334155", borderRadius: 8, padding: 10 }}>
          <b>{resolution.type === "REFUND" ? "Refund started" : "Customer-approved rebooking"}</b> — {new Date(resolution.at).toLocaleString()} by {resolution.by ?? "admin"}: {resolution.reason}
          {refund && <div style={{ marginTop: 4 }}>Refund {refund.refundAmount} {refund.currency} · {refund.refundMethod} · <b style={{ color: refund.refundStatus === "DONE" ? "#4ade80" : "#fbbf24" }}>{refund.refundStatus}</b>
            {refund.refundReference ? ` · ${refund.refundReference}` : ""}{refund.refundedAt ? ` · ${new Date(refund.refundedAt).toLocaleString()}` : ""}
            {refund.refundError && <div style={{ color: "#fca5a5" }}>{refund.refundError} — retry or mark it refunded in Admin → Cancellations.</div>}</div>}
          {resolution.type === "REBOOK" && <div style={{ marginTop: 4 }}>Book it on Akbar&apos;s portal, then enter the PNR with Issue ticket. A refund is still possible if the rebooking can&apos;t be done.</div>}
        </div>
      )}
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {canBook && <button disabled={!!busy} onClick={() => run("book")} style={btn}>{busy === "book" ? "Booking on Akbar…" : paid ? "Continue Akbar booking" : "Book on Akbar API"}</button>}
        {paid && <button disabled={!!busy} onClick={() => run("refresh")} style={{ ...btn, background: "#0f172a", border: "1px solid #334155" }}>{busy === "refresh" ? "Checking…" : "Refresh from Akbar"}</button>}
      </div>
    </div>
  );
}

const box: React.CSSProperties = { border: "1px solid #a16207", borderRadius: 10, padding: 14, margin: "10px 0", background: "rgba(245,158,11,.06)" };
const lbl: React.CSSProperties = { color: "#94a3b8", fontSize: 12, display: "grid", gap: 4 };
const inp: React.CSSProperties = { background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 6, padding: "6px 8px", fontSize: 13 };
const btn: React.CSSProperties = { background: "#0D4B96", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
