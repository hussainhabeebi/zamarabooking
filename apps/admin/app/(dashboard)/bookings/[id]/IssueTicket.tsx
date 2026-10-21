"use client";
import { useState } from "react";
import { API, apiHeaders } from "../../../../lib/api";

const SOURCE: Record<string, string> = { POOMAS: "Poomas", MANUAL: "manual fare" };

// Poomas / manual fare bookings: staff issue the ticket outside Zamra, then enter
// the PNR here. The API saves it, builds the e-ticket and emails the customer.
export function IssueTicket({ booking, passengers, onDone }: {
  booking: { id: string; supplier: string; status: string; pnr: string | null; ticketNumbers: string[] | null; supplierBookingRef: string | null };
  passengers: { firstName: string; lastName: string; passengerType: string }[];
  onDone: (message: string) => void;
}) {
  const issued = booking.status === "TICKETED";
  const [pnr, setPnr] = useState(booking.pnr ?? "");
  const [tickets, setTickets] = useState<string[]>(passengers.map((_, i) => booking.ticketNumbers?.[i] ?? ""));
  const [ref, setRef] = useState(booking.supplierBookingRef ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/bookings/${booking.id}/issue-ticket`, {
        method: "POST", headers: apiHeaders(),
        body: JSON.stringify({ pnr, ticketNumbers: tickets.map((t) => t.trim()), ...(ref.trim() ? { supplierRef: ref.trim() } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      onDone(d.emailed ? `Ticket issued — PNR ${d.pnr}. The e-ticket has been emailed to the customer.` : `Ticket details updated — PNR ${d.pnr}. The e-ticket was rebuilt (no new email).`);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  if (booking.status !== "CONFIRMED" && booking.status !== "TICKETED") return null;
  return (
    <form onSubmit={submit} style={{ ...box, borderColor: issued ? "#166534" : "#a16207", background: issued ? "rgba(34,197,94,.06)" : "rgba(234,179,8,.08)" }}>
      <div style={{ fontWeight: 800, color: issued ? "#86efac" : "#fde047", fontSize: 14, marginBottom: 4 }}>
        {issued ? "Ticket issued" : "Paid — waiting for staff to issue the ticket"}
      </div>
      <p style={{ color: "#cbd5e1", fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
        This is a {SOURCE[booking.supplier] ?? booking.supplier} booking. {booking.supplier === "POOMAS" ? "Book it on Poomas" : "Issue it with the airline / consolidator"}, then enter the airline PNR
        {issued ? " to correct it." : " and ticket numbers. Saving sends the e-ticket to the customer."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <label style={lbl}>Airline PNR *
          <input required value={pnr} onChange={(e) => setPnr(e.target.value.toUpperCase())} maxLength={8} placeholder="e.g. X7KQ2P" style={input} />
        </label>
        <label style={lbl}>{booking.supplier === "POOMAS" ? "Poomas booking ID" : "Supplier reference"} (optional)
          <input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} style={input} />
        </label>
        {passengers.map((p, i) => (
          <label key={i} style={lbl}>Ticket no. — {p.firstName} {p.lastName} ({p.passengerType.toLowerCase()})
            <input value={tickets[i]} onChange={(e) => setTickets((t) => t.map((v, j) => (j === i ? e.target.value : v)))} maxLength={30} style={input} />
          </label>
        ))}
      </div>
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 10 }}>{error}</div>}
      <button disabled={busy} style={{ marginTop: 12, background: "#0D4B96", color: "#fff", border: 0, borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>
        {busy ? "Saving…" : issued ? "Update ticket details" : "Issue ticket & email customer"}
      </button>
    </form>
  );
}

const box: React.CSSProperties = { border: "1px solid", borderRadius: 10, padding: 14, margin: "10px 0" };
const lbl: React.CSSProperties = { display: "grid", gap: 5, fontSize: 12, fontWeight: 600, color: "#94a3b8" };
const input: React.CSSProperties = { padding: "8px 10px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
