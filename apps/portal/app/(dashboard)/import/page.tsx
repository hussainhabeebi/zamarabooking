"use client";

import { FormEvent, useState } from "react";
import { api } from "../../../lib/api";

type Ticket = {
  pnr: string | null; airlineBookingRef: string | null; airline: string | null; totalAmount: number | null; currency: string | null; issuedBy: string | null;
  passengers: { name: string; type: string; ticketNumber: string | null }[];
  segments: { from: string; to: string; flightNumber: string | null; departure: string | null; arrival: string | null; cabin: string | null; baggage: string | null }[];
};
type Stored = { key: string; name: string; type: string; size: number };

// Offline / imported bookings: tickets issued elsewhere (another portal, the
// airline counter). The AI reads the e-ticket; staff verify before it is linked.
export default function ImportPage() {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [file, setFile] = useState<Stored | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState({ pnr: "", airline: "", route: "", travelDate: "", passengers: "", note: "" });

  async function read(f?: File) {
    if (!f) return;
    setReading(true); setError(""); setTicket(null);
    try {
      const form = new FormData();
      form.append("file", f);
      const d = await api<{ ticket: Ticket; file: Stored }>("/api/agent/import/ticket", { method: "POST", body: form });
      setTicket(d.ticket); setFile(d.file);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't read the ticket"); } finally { setReading(false); }
  }

  async function submitScanned() {
    if (!ticket) return;
    setBusy(true); setError("");
    try {
      const route = ticket.segments.length ? `${ticket.segments[0].from} → ${ticket.segments[ticket.segments.length - 1].to}` : "";
      const r = await api<{ request: { id: string } }>("/api/agent/requests", { json: {
        type: "OFFLINE_BOOKING", title: `Offline booking ${ticket.pnr ?? ""} ${route}`.trim(),
        details: { pnr: ticket.pnr, airline: ticket.airline, route, travelDate: ticket.segments[0]?.departure?.slice(0, 10) ?? null,
          passengers: ticket.passengers.map((p) => `${p.name}${p.ticketNumber ? ` (${p.ticketNumber})` : ""}`).join(", "),
          amount: ticket.totalAmount, currency: ticket.currency, issuedBy: ticket.issuedBy, ticket, file },
      } });
      window.location.assign(`/requests/${r.request.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save"); setBusy(false); }
  }

  async function submitManual(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api<{ request: { id: string } }>("/api/agent/requests", { json: {
        type: "OFFLINE_BOOKING", title: `Offline booking ${manual.pnr.toUpperCase()} ${manual.route}`.trim(), details: { ...manual, pnr: manual.pnr.toUpperCase() },
      } });
      window.location.assign(`/requests/${r.request.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't save"); setBusy(false); }
  }

  return (
    <div>
      <div className="page-head"><div><h1>Offline booking</h1><p>Register tickets booked elsewhere, so you can manage reissues, cancellations and support with us.</p></div></div>
      {error && <div className="banner bad">{error}</div>}
      <div className="grid g2">
        <div className="card stack">
          <h2>📄 Read an e-ticket</h2>
          <p className="small muted" style={{ margin: 0 }}>Upload the e-ticket PDF or a photo. We read the PNR, travellers, ticket numbers and flights for you to check.</p>
          <label className="btn" style={{ alignSelf: "flex-start", cursor: "pointer" }}>{reading ? <><span className="spin" /> Reading ticket…</> : "Upload e-ticket"}
            <input type="file" hidden accept="application/pdf,image/*" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {ticket && (
            <div className="stack">
              <dl className="kv small">
                <dt>PNR</dt><dd>{ticket.pnr ?? "Not found"}</dd>
                <dt>Airline</dt><dd>{ticket.airline ?? "—"}</dd>
                <dt>Issued by</dt><dd>{ticket.issuedBy ?? "—"}</dd>
                {ticket.totalAmount && <><dt>Fare</dt><dd>{ticket.currency} {ticket.totalAmount}</dd></>}
              </dl>
              <div className="table-wrap"><table className="t"><tbody>
                {ticket.segments.map((s, i) => <tr key={i}><td>{s.flightNumber}</td><td>{s.from} → {s.to}</td><td className="small">{s.departure?.replace("T", " ")}</td><td className="small">{s.baggage}</td></tr>)}
              </tbody></table></div>
              <div className="table-wrap"><table className="t"><tbody>
                {ticket.passengers.map((p, i) => <tr key={i}><td>{p.name}</td><td className="small">{p.type.toLowerCase()}</td><td className="small">{p.ticketNumber ?? ""}</td></tr>)}
              </tbody></table></div>
              <button className="btn primary" disabled={busy} onClick={submitScanned}>Looks right — register booking</button>
            </div>
          )}
        </div>
        <form className="card stack" onSubmit={submitManual}>
          <h2>⌨️ Or enter the details</h2>
          <div className="grid g2">
            <label className="f">PNR<input required value={manual.pnr} onChange={(e) => setManual((m) => ({ ...m, pnr: e.target.value }))} /></label>
            <label className="f">Airline<input value={manual.airline} onChange={(e) => setManual((m) => ({ ...m, airline: e.target.value }))} /></label>
            <label className="f">Route<input value={manual.route} placeholder="COK → DXB" onChange={(e) => setManual((m) => ({ ...m, route: e.target.value }))} /></label>
            <label className="f">Travel date<input type="date" value={manual.travelDate} onChange={(e) => setManual((m) => ({ ...m, travelDate: e.target.value }))} /></label>
          </div>
          <label className="f">Travellers<input value={manual.passengers} onChange={(e) => setManual((m) => ({ ...m, passengers: e.target.value }))} /></label>
          <label className="f">What do you need?<textarea value={manual.note} onChange={(e) => setManual((m) => ({ ...m, note: e.target.value }))} placeholder="e.g. Date change to 20 Dec" /></label>
          <button className="btn" disabled={busy} style={{ alignSelf: "flex-start" }}>Register booking</button>
        </form>
      </div>
    </div>
  );
}
