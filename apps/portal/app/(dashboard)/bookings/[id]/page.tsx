"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, fmtDate, fmtTime, money, STATUS_STYLE } from "../../../../lib/api";
import { useMe } from "../../Shell";

interface Segment { airline: string; airlineName: string; flightNumber: string; from: { code: string; city?: string; terminal?: string }; to: { code: string; city?: string; terminal?: string }; departure: string; arrival: string; cabinBaggage?: string; checkedBaggage?: string }
interface Trip {
  id: string; status: string; pnr: string | null; origin: string; destination: string; departureDate: string | null; currency: string;
  totalAmount: number; serviceFee: number; contactEmail: string | null; contactPhone: string | null; createdAt: string;
  passengers: { id: string; type: string; firstName: string; lastName: string }[];
  payments: { id: string; gateway: string; amount: number; currency: string; status: string; createdAt: string }[];
  cancellations: { id: string; status: string; refundAmount: number | null; refundStatus: string; createdAt: string }[];
  itinerary: { pnr?: string; segments: Segment[]; travellers: { name: string; type?: string; ticketNumber?: string; pnr?: string }[] } | null;
}
interface Invoice {
  invoice: { number: string; date: string; pnr: string | null; origin: string; destination: string; departureDate: string; currency: string; passengers: { firstName: string; lastName: string; type: string }[]; fare: number; serviceFee: number; total: number; sellingPrice: number | null; gstNumber: string | null; status: string };
  agency: { name: string; businessName: string; logoUrl: string | null; color: string; phone: string; email: string; address: string | null; gstNumber: string | null } | null;
  creditNotes: { number: string; amount: number; charges: number; date: string | null }[];
}
interface Quote { amountPaid: number; supplierCharges: number; refundAmount: number; currency: string; refundTo: string }

const CHANGE_TYPES = [["DATE_CHANGE", "Change travel date"], ["NAME_CORRECTION", "Correct a name"], ["ADD_BAGGAGE", "Add baggage"], ["MEAL_SEAT", "Meal or seat"], ["REISSUE", "Reissue ticket"], ["OTHER", "Something else"]];

export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me, reload } = useMe();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [print, setPrint] = useState<"ticket" | "invoice" | null>(null);
  const [change, setChange] = useState({ type: "DATE_CHANGE", message: "" });
  const [sellAs, setSellAs] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const d = await api<{ trip: Trip; cancelBlocker: string | null }>(`/api/agent/trips/${id}`);
      setTrip(d.trip); setBlocker(d.cancelBlocker);
      api<Invoice>(`/api/agent/bookings/${id}/invoice`).then((x) => { setInv(x); if (x.invoice.sellingPrice) setSellAs(String(x.invoice.sellingPrice)); }).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load the booking"); }
  }, [id]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("paid")) setNotice("Paid from your wallet. We're issuing the ticket with the airline — this page updates automatically.");
    if (q.get("held")) setNotice("Fare on hold. Pay before the time limit to issue the ticket.");
    if (q.get("payError")) setError(q.get("payError")!);
    load();
  }, [load]);

  // Keep checking while the airline confirms.
  useEffect(() => {
    if (trip?.status !== "PAYMENT_PENDING" || !trip.payments.some((p) => p.status === "SUCCESS")) return;
    const t = setTimeout(load, 8000);
    return () => clearTimeout(t);
  }, [trip, load]);

  useEffect(() => {
    if (!print) return;
    const done = () => setPrint(null);
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 100);
    return () => window.removeEventListener("afterprint", done);
  }, [print]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
  }

  if (error && !trip) return <div><a href="/bookings">← Bookings</a><div className="banner bad" style={{ marginTop: 12 }}>{error}</div></div>;
  if (!trip) return <p className="muted"><span className="spin" /> Loading…</p>;

  const st = STATUS_STYLE[trip.status] ?? { label: trip.status, cls: "b-grey" };
  const paid = trip.payments.some((p) => p.status === "SUCCESS");
  const toPay = ["HELD", "PAYMENT_PENDING"].includes(trip.status) && !paid;
  const ticketed = ["CONFIRMED", "TICKETED"].includes(trip.status);
  const pnr = trip.pnr ?? trip.itinerary?.pnr ?? null;
  const segs = trip.itinerary?.segments ?? [];
  const travellers = trip.itinerary?.travellers?.length ? trip.itinerary.travellers : trip.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, type: p.type, ticketNumber: undefined as string | undefined }));
  const brand = inv?.agency;

  return (
    <div>
      <div className="no-print">
        <a href="/bookings">← Bookings</a>
        <div className="page-head" style={{ marginTop: 8 }}>
          <div><h1>{trip.origin} → {trip.destination}</h1><p>{fmtDate(trip.departureDate)} · {trip.passengers.length} traveller{trip.passengers.length > 1 ? "s" : ""} · booked {fmtDate(trip.createdAt)}</p></div>
          <span className={`badge ${st.cls}`} style={{ fontSize: 13 }}>{st.label}</span>
        </div>
        {notice && <div className="banner ok">{notice}</div>}
        {error && <div className="banner bad">{error}</div>}

        <div className="grid g3" style={{ marginBottom: 16 }}>
          <div className="stat"><small>Airline PNR</small><b>{pnr ?? "—"}</b><span>Booking ID {trip.id.slice(0, 8).toUpperCase()}</span></div>
          <div className="stat"><small>Your cost (net)</small><b>{money(trip.totalAmount, trip.currency)}</b><span>{paid ? "Paid from wallet" : "Not paid yet"}</span></div>
          <div className="stat"><small>Customer contact</small><b style={{ fontSize: 14 }}>{trip.contactPhone ?? "—"}</b><span>{trip.contactEmail}</span></div>
        </div>

        {toPay && (
          <div className="card" style={{ borderColor: "#fde68a", background: "#fffbeb" }}>
            <div className="row between">
              <div><b>{trip.status === "HELD" ? "🔒 Fare on hold" : "Payment pending"}</b><div className="small muted">Pay {money(trip.totalAmount, trip.currency)} from your wallet to issue the ticket. Available {money(me?.credit.available ?? 0, trip.currency)}.</div></div>
              <button className="btn primary" disabled={busy} onClick={() => run(async () => {
                await api(`/api/agent/bookings/${trip.id}/pay`, { method: "POST" });
                setNotice("Paid. We're issuing the ticket with the airline — this page updates automatically.");
                reload(); await load();
              })}>{busy ? "Paying…" : "Pay from wallet"}</button>
            </div>
          </div>
        )}
        {trip.status === "PAYMENT_PENDING" && paid && <div className="banner info"><span className="spin" /> Paid — confirming with the airline. This usually takes under a minute.</div>}
        {trip.status === "PAYMENT_FAILED" && <div className="banner bad">The airline couldn&apos;t issue this booking. Any wallet payment has been refunded to your wallet.</div>}

        <div className="card">
          <h2>Flights</h2>
          {segs.length === 0 ? <p className="muted small">Flight details appear once the airline confirms.</p> : segs.map((s, i) => (
            <div key={i} className="row between" style={{ padding: "8px 0", borderBottom: i < segs.length - 1 ? "1px solid #f1f5f9" : 0 }}>
              <div><b>{s.airlineName || s.airline} {s.flightNumber}</b><div className="small muted">{s.checkedBaggage ? `Check-in ${s.checkedBaggage}` : ""}{s.cabinBaggage ? ` · cabin ${s.cabinBaggage}` : ""}</div></div>
              <div style={{ textAlign: "right" }}><b>{s.from.code} {fmtTime(s.departure)} → {s.to.code} {fmtTime(s.arrival)}</b><div className="small muted">{fmtDate(s.departure)}{s.from.terminal ? ` · T${s.from.terminal}` : ""}</div></div>
            </div>
          ))}
          <h2 style={{ marginTop: 16 }}>Travellers</h2>
          {travellers.map((t, i) => <div key={i} className="row between small" style={{ padding: "4px 0" }}><span>{t.name} <span className="muted">· {t.type?.toLowerCase()}</span></span><span className="muted">{t.ticketNumber ? `Ticket ${t.ticketNumber}` : ""}</span></div>)}
        </div>

        {ticketed && (
          <div className="card">
            <h2>Documents for your customer</h2>
            <div className="row">
              <label className="f" style={{ width: 200 }}>Show selling price ({trip.currency})<input type="number" min={0} value={sellAs} onChange={(e) => setSellAs(e.target.value)} placeholder="Hide price" /></label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => setPrint("ticket")}>🖨 Branded e-ticket</button>
              <button className="btn" onClick={() => setPrint("invoice")}>🧾 Invoice</button>
              <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(`Your flight ${trip.origin} → ${trip.destination} on ${fmtDate(trip.departureDate)} is confirmed. PNR: ${pnr ?? "-"}.${brand ? ` — ${brand.name} ${brand.phone}` : ""}`)}`} target="_blank" rel="noopener">WhatsApp details</a>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>E-tickets and invoices carry your agency logo and contacts (set them in Profile & branding). Use “Save as PDF” in the print window to share.</p>
          </div>
        )}

        {ticketed && (
          <div className="card">
            <h2>Changes</h2>
            <div className="grid g2">
              <div className="stack">
                <label className="f">What do you need?<select value={change.type} onChange={(e) => setChange((c) => ({ ...c, type: e.target.value }))}>{CHANGE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className="f">Details<textarea value={change.message} onChange={(e) => setChange((c) => ({ ...c, message: e.target.value }))} placeholder="e.g. Move to 14 Nov, same flight" /></label>
                <button className="btn" disabled={busy || change.message.trim().length < 3} onClick={() => run(async () => {
                  const r = await api<{ request: { id: string } }>("/api/agent/requests", { json: { type: "AMENDMENT", bookingId: trip.id, title: `${CHANGE_TYPES.find((c) => c[0] === change.type)?.[1]} · ${trip.origin}-${trip.destination} ${pnr ?? ""}`.trim(), details: { change: change.type, message: change.message.trim(), pnr } } });
                  window.location.assign(`/requests/${r.request.id}`);
                })}>Send change request</button>
              </div>
              <div className="stack">
                <b>Cancel booking</b>
                {blocker ? <p className="small muted" style={{ margin: 0 }}>{blocker}</p> : quote ? (
                  <>
                    <dl className="kv small"><dt>Paid</dt><dd>{money(quote.amountPaid, quote.currency)}</dd><dt>Airline charges</dt><dd>{money(quote.supplierCharges, quote.currency)}</dd><dt>Refund</dt><dd>{money(quote.refundAmount, quote.currency)} to {quote.refundTo}</dd></dl>
                    <div className="row">
                      <button className="btn danger" disabled={busy} onClick={() => run(async () => {
                        const r = await api<{ message?: string }>(`/api/agent/trips/${trip.id}/cancel`, { json: { confirm: true } });
                        setQuote(null); setNotice(r.message ?? "Cancellation submitted to the airline."); await load();
                      })}>Confirm cancellation</button>
                      <button className="btn" onClick={() => setQuote(null)}>Keep booking</button>
                    </div>
                  </>
                ) : (
                  <button className="btn danger" disabled={busy} onClick={() => run(async () => {
                    const r = await api<{ quote: Quote }>(`/api/agent/trips/${trip.id}/cancel/quote`, { method: "POST" });
                    setQuote(r.quote);
                  })}>Check cancellation charges</button>
                )}
                {trip.cancellations[0] && <p className="small muted" style={{ margin: 0 }}>Cancellation: {trip.cancellations[0].status.toLowerCase()} · refund {trip.cancellations[0].refundStatus.toLowerCase()}</p>}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Printable branded e-ticket / invoice */}
      {print && (
        <div className="print-only" style={{ fontFamily: "Inter, Arial, sans-serif", color: "#0f172a" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `3px solid ${brand?.color ?? "#E31E24"}`, paddingBottom: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {brand?.logoUrl && <img src={brand.logoUrl} alt="" style={{ height: 48 }} />}
              <div><div style={{ fontSize: 20, fontWeight: 800 }}>{brand?.name ?? "Travel agency"}</div><div style={{ fontSize: 12, color: "#475569" }}>{brand?.phone} · {brand?.email}{brand?.address ? ` · ${brand.address}` : ""}</div></div>
            </div>
            <div style={{ textAlign: "right" }}><div style={{ fontSize: 18, fontWeight: 800 }}>{print === "ticket" ? "E-TICKET" : "INVOICE"}</div>
              {print === "invoice" && inv && <div style={{ fontSize: 12 }}>{inv.invoice.number} · {fmtDate(inv.invoice.date)}</div>}
              {brand?.gstNumber && <div style={{ fontSize: 12 }}>GSTIN/TRN {brand.gstNumber}</div>}</div>
          </div>
          <div style={{ fontSize: 14, marginBottom: 12 }}><b>PNR: {pnr ?? "—"}</b> · {trip.origin} → {trip.destination} · {fmtDate(trip.departureDate)}</div>
          {print === "ticket" ? (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 14 }}>
                <thead><tr style={{ background: "#f1f5f9" }}><th style={pc}>Flight</th><th style={pc}>From</th><th style={pc}>To</th><th style={pc}>Baggage</th></tr></thead>
                <tbody>{segs.map((s, i) => <tr key={i}><td style={pc}>{s.airlineName} {s.flightNumber}</td><td style={pc}>{s.from.code} {fmtDate(s.departure)} {fmtTime(s.departure)}{s.from.terminal ? ` T${s.from.terminal}` : ""}</td><td style={pc}>{s.to.code} {fmtTime(s.arrival)}</td><td style={pc}>{s.checkedBaggage ?? "-"}{s.cabinBaggage ? ` / ${s.cabinBaggage} cabin` : ""}</td></tr>)}</tbody>
              </table>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ background: "#f1f5f9" }}><th style={pc}>Traveller</th><th style={pc}>Type</th><th style={pc}>Ticket number</th></tr></thead>
                <tbody>{travellers.map((t, i) => <tr key={i}><td style={pc}>{t.name}</td><td style={pc}>{t.type?.toLowerCase()}</td><td style={pc}>{t.ticketNumber ?? "-"}</td></tr>)}</tbody>
              </table>
              {Number(sellAs) > 0 && <p style={{ fontSize: 14, marginTop: 14 }}>Total fare: <b>{money(Number(sellAs), trip.currency)}</b></p>}
              <p style={{ fontSize: 11, color: "#475569", marginTop: 16 }}>Carry a valid photo ID / passport. Check in online 48 hours before departure; airport counters close 60 minutes (domestic) / 3 hours (international) before departure.</p>
            </>
          ) : inv && (
            <>
              <p style={{ fontSize: 13 }}>Billed to: {trip.passengers.map((p) => `${p.firstName} ${p.lastName}`).join(", ")}{inv.invoice.gstNumber ? ` · GSTIN ${inv.invoice.gstNumber}` : ""}</p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  <tr><td style={pc}>Air fare — {trip.origin} → {trip.destination}, {inv.invoice.passengers.length} traveller(s)</td><td style={{ ...pc, textAlign: "right" }}>{money(Number(sellAs) > 0 ? Number(sellAs) : inv.invoice.total, trip.currency)}</td></tr>
                  <tr style={{ fontWeight: 800 }}><td style={pc}>Total</td><td style={{ ...pc, textAlign: "right" }}>{money(Number(sellAs) > 0 ? Number(sellAs) : inv.invoice.total, trip.currency)}</td></tr>
                </tbody>
              </table>
              {inv.creditNotes.map((cn) => <p key={cn.number} style={{ fontSize: 13 }}>Credit note {cn.number}: refund {money(cn.amount, trip.currency)} (airline charges {money(cn.charges, trip.currency)}) {cn.date ? `on ${fmtDate(cn.date)}` : ""}</p>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const pc: React.CSSProperties = { border: "1px solid #e2e8f0", padding: "6px 8px", textAlign: "left" };
