"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiCall, inr, openETicket, STATUS_LABEL } from "../lib/customer-api";
import { Rebook } from "./Rebook";

type Mode = "customer" | "guest";
interface Segment { airline: string; airlineName: string; flightNumber: string; from: { code: string; city?: string; name?: string; terminal?: string }; to: { code: string; city?: string; name?: string; terminal?: string }; departure: string; arrival: string; durationMin?: number; cabinBaggage?: string; checkedBaggage?: string }
interface Trip {
  id: string; status: string; pnr: string | null; origin: string; destination: string; departureDate: string | null;
  currency: string; totalAmount: number; serviceFee: number; contactEmail: string | null; contactPhone: string | null; createdAt: string;
  passengers: { id: string; type: string; firstName: string; lastName: string }[];
  payments: { id: string; gateway: string; amount: number; currency: string; status: string; createdAt: string }[];
  cancellations: { id: string; status: string; supplierCharges: number | null; refundAmount: number | null; refundMethod: string; refundStatus: string; refundedAt: string | null; createdAt: string }[];
  itinerary: { supplierStatus?: string; pnr?: string; segments: Segment[]; travellers: { name: string; type?: string; pnr?: string; ticketNumber?: string }[] } | null;
  eticketAvailable: boolean;
}
interface Quote { amountPaid: number; serviceFee: number; supplierFare: number; supplierCharges: number; refundAmount: number; currency: string; refundMethod: string; refundTo: string }
interface SupportReq { id: string; type: string; message: string; status: string; adminNote: string | null; createdAt: string; bookingId: string | null }

const SUPPORT_TYPES: [string, string][] = [
  ["DATE_CHANGE", "Change travel date"], ["ADD_BAGGAGE", "Add extra baggage"], ["MEAL_SEAT", "Meal or seat request"],
  ["NAME_CORRECTION", "Correct a name"], ["CANCELLATION_HELP", "Help with cancellation"], ["OTHER", "Something else"],
];
const CANCEL_LABEL: Record<string, string> = {
  SUBMITTED: "Cancellation requested — confirming with the airline", PROCESSING: "Cancellation in progress with the airline",
  SUCCESS: "Cancelled", REJECTED: "Cancellation was not accepted by the airline", FAILED: "Cancellation request failed",
};

const REFUND_TO: Record<string, string> = { WALLET: "your POOMAS wallet", NOMOD: "your original card / payment method", MANUAL: "your original payment method" };

const fmtTime = (s: string) => { const d = new Date(s); return isNaN(+d) ? s : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }); };
const fmtDate = (s: string | null) => { if (!s) return "—"; const d = new Date(s); return isNaN(+d) ? s : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); };

export default function TripDetail({ mode, id }: { mode: Mode; id?: string }) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [cancelBlocker, setCancelBlocker] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [requests, setRequests] = useState<SupportReq[]>([]);
  const [reqType, setReqType] = useState("DATE_CHANGE");
  const [reqMsg, setReqMsg] = useState("");

  const base = mode === "customer" ? `/api/profile/trips/${id}` : "/api/trips/view";

  const load = useCallback(async () => {
    try {
      const d = await apiCall<{ trip: Trip; cancelBlocker: string | null }>(base, { auth: mode });
      setTrip(d.trip); setCancelBlocker(d.cancelBlocker);
      if (mode === "customer") {
        const s = await apiCall<{ requests: SupportReq[] }>("/api/profile/support", { auth: mode }).catch(() => ({ requests: [] }));
        setRequests(s.requests.filter((r) => r.bookingId === id));
      }
    } catch (e: any) { setError(e.message); }
  }, [base, mode, id]);

  useEffect(() => { load(); }, [load]);

  // Keep checking while a cancellation is being processed.
  useEffect(() => {
    if (!trip?.cancellations.some((c) => ["SUBMITTED", "PROCESSING"].includes(c.status))) return;
    const t = setTimeout(load, 60_000);
    return () => clearTimeout(t);
  }, [trip, load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !trip) {
    return (
      <main className="page-container" style={{ padding: "32px 16px", maxWidth: 560 }}>
        <div style={errBox}>{error}</div>
        <a href={mode === "customer" ? "/trips" : "/trips/find"} style={secondaryBtn}>Back</a>
      </main>
    );
  }
  if (!trip) return <main className="page-container" style={{ padding: "32px 16px" }}>Loading booking…</main>;

  const st = STATUS_LABEL[trip.status] ?? { label: trip.status, color: "#334155", bg: "#f1f5f9" };
  const segs = trip.itinerary?.segments ?? [];
  const travellers = trip.itinerary?.travellers?.length ? trip.itinerary.travellers
    : trip.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, type: p.type, ticketNumber: undefined as string | undefined, pnr: undefined as string | undefined }));
  const pnr = trip.pnr ?? trip.itinerary?.pnr;
  const airlineName = segs[0]?.airlineName || "";
  const latestCancel = trip.cancellations[0];
  const ticketed = ["CONFIRMED", "TICKETED"].includes(trip.status);
  const receiptHref = mode === "customer" ? `/trips/${trip.id}/receipt` : "/trips/guest/receipt";
  const eticketPath = mode === "customer" ? `/api/profile/trips/${trip.id}/eticket` : "/api/trips/eticket";

  return (
    <main className="page-container" style={{ padding: "20px 16px 56px", maxWidth: 820 }}>
      <a href={mode === "customer" ? "/trips" : "/trips/find"} style={{ fontSize: 14, color: "#64748b", textDecoration: "none" }}>← {mode === "customer" ? "My Trips" : "Find another booking"}</a>

      <section style={{ ...card, marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{trip.origin} → {trip.destination}</h1>
            <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>{fmtDate(trip.departureDate)} · {trip.passengers.length} traveller{trip.passengers.length > 1 ? "s" : ""}</p>
          </div>
          <span style={{ fontSize: 12, fontWeight: 800, color: st.color, background: st.bg, borderRadius: 20, padding: "5px 11px" }}>{st.label}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 14 }}>
          <Info label="PNR" value={pnr ?? "Pending"} mono />
          <Info label="Booking ID" value={trip.id.slice(0, 8).toUpperCase()} mono />
          <Info label="Booked on" value={fmtDate(trip.createdAt)} />
          <Info label="Total paid" value={inr(trip.totalAmount, trip.currency)} />
        </div>
      </section>

      {error && <div style={errBox}>{error}</div>}
      {notice && <div style={okBox}>{notice}</div>}

      {latestCancel && (
        <section style={{ ...card, marginTop: 12, borderColor: latestCancel.status === "SUCCESS" ? "#bbf7d0" : latestCancel.status === "REJECTED" || latestCancel.status === "FAILED" ? "#fecaca" : "#fde68a" }}>
          <strong>{CANCEL_LABEL[latestCancel.status] ?? latestCancel.status}</strong>
          <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 14 }}>
            {latestCancel.status === "SUCCESS" && latestCancel.refundStatus === "DONE"
              ? `${inr(latestCancel.refundAmount ?? 0, trip.currency)} refunded to ${REFUND_TO[latestCancel.refundMethod] ?? "your original payment method"} on ${fmtDate(latestCancel.refundedAt)}.${latestCancel.refundMethod === "NOMOD" ? " It can take 5–10 working days to appear on your statement." : ""}`
              : latestCancel.status === "SUCCESS"
                ? `Refund of ${inr(latestCancel.refundAmount ?? 0, trip.currency)} to ${REFUND_TO[latestCancel.refundMethod] ?? "your original payment method"} is being processed.`
                : ["SUBMITTED", "PROCESSING"].includes(latestCancel.status)
                  ? `Expected refund ${inr(latestCancel.refundAmount ?? 0, trip.currency)} to ${REFUND_TO[latestCancel.refundMethod] ?? "your original payment method"} once the airline confirms. This page updates automatically.`
                  : "Your booking is unchanged. Contact us below if you still want to cancel."}
          </p>
        </section>
      )}

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>Flight itinerary</h2>
        {segs.length === 0 ? (
          <p style={muted}>{ticketed ? "Live flight details are temporarily unavailable. Your e-ticket has the full itinerary." : "Flight details appear here once the booking is confirmed."}</p>
        ) : segs.map((s, i) => (
          <div key={i} style={{ padding: "12px 0", borderTop: i ? "1px dashed #e2e8f0" : "none" }}>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}><strong style={{ color: "#0f172a" }}>{s.airlineName || s.airline}</strong> · {s.flightNumber}{s.durationMin ? ` · ${Math.floor(s.durationMin / 60)}h ${s.durationMin % 60}m` : ""}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtTime(s.departure)}</div>
                <div style={{ fontWeight: 700 }}>{s.from.code}{s.from.city ? ` · ${s.from.city}` : ""}</div>
                <small style={{ color: "#64748b" }}>{fmtDate(s.departure)}{s.from.terminal ? ` · ${s.from.terminal}` : ""}</small>
              </div>
              <span style={{ color: "#E31E24" }}>✈</span>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtTime(s.arrival)}</div>
                <div style={{ fontWeight: 700 }}>{s.to.code}{s.to.city ? ` · ${s.to.city}` : ""}</div>
                <small style={{ color: "#64748b" }}>{fmtDate(s.arrival)}{s.to.terminal ? ` · ${s.to.terminal}` : ""}</small>
              </div>
            </div>
            {(s.cabinBaggage || s.checkedBaggage) && <small style={{ display: "block", color: "#64748b", marginTop: 6 }}>Baggage: {s.cabinBaggage ? `cabin ${s.cabinBaggage}` : ""}{s.cabinBaggage && s.checkedBaggage ? " · " : ""}{s.checkedBaggage ? `check-in ${s.checkedBaggage}` : ""}</small>}
          </div>
        ))}
      </section>

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>Travellers</h2>
        {travellers.map((t, i) => (
          <div key={i} style={row}>
            <span>{t.name}{t.type ? <small style={{ color: "#64748b" }}> · {t.type.toLowerCase()}</small> : null}</span>
            <small style={{ color: "#475569", fontFamily: "monospace" }}>{t.ticketNumber ? `Ticket ${t.ticketNumber}` : ""}</small>
          </div>
        ))}
      </section>

      {ticketed && (
        <section style={{ ...card, marginTop: 12 }}>
          <h2 style={h2}>Your documents</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={busy} onClick={() => run(() => openETicket(eticketPath, mode))} style={primaryBtnBtn}>View / print e-ticket</button>
            {mode === "customer" && (
              <button disabled={busy} style={secondaryBtnBtn} onClick={() => run(async () => {
                const r = await apiCall<{ email?: string }>(`/api/profile/trips/${trip.id}/eticket/send`, { method: "POST" });
                setNotice(`E-ticket sent${r.email ? ` to ${r.email}` : ""} (and WhatsApp if available).`);
              })}>Email / WhatsApp e-ticket</button>
            )}
            <a href={receiptHref} style={secondaryBtn}>Payment receipt</a>
            {airlineName && (
              <a href={`https://www.google.com/search?q=${encodeURIComponent(`${airlineName} web check-in`)}`} target="_blank" rel="noopener" style={secondaryBtn}>Web check-in ↗</a>
            )}
          </div>
          <p style={{ ...muted, margin: "10px 0 0" }}>Web check-in usually opens 48 hours before departure on the airline's website. Use your PNR{pnr ? ` ${pnr}` : ""} and last name.</p>
        </section>
      )}

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>Payment</h2>
        <div style={row}><span>Total paid</span><strong>{inr(trip.totalAmount, trip.currency)}</strong></div>
        {trip.payments.map((p) => (
          <div key={p.id} style={row}>
            <small style={{ color: "#64748b" }}>{p.gateway === "WALLET" ? "POOMAS wallet" : p.gateway === "NOMOD" ? "Card (Nomod)" : p.gateway} · {fmtDate(p.createdAt)}</small>
            <small style={{ fontWeight: 700, color: p.status === "SUCCESS" ? "#166534" : "#475569" }}>{p.status.replace("_", " ").toLowerCase()}</small>
          </div>
        ))}
      </section>

      {mode === "customer" && trip.status === "HELD" && (
        <section style={{ ...card, marginTop: 12, borderColor: "#fde68a", background: "#fffbeb" }}>
          <h2 style={h2}>🔒 Fare on hold</h2>
          <p style={muted}>Pay before the airline&apos;s time limit to get your e-ticket. After that the seats are released.</p>
          <button disabled={busy} style={primaryBtnBtn} onClick={() => run(async () => {
            const r = await apiCall<{ url: string }>(`/api/profile/trips/${trip.id}/pay-link`, { method: "POST" });
            window.location.assign(r.url);
          })}>Pay now</button>
        </section>
      )}

      {mode === "customer" && (
        <section style={{ ...card, marginTop: 12 }}>
          <Rebook tripId={trip.id} origin={trip.origin} destination={trip.destination} />
        </section>
      )}

      {mode === "customer" && ticketed && !cancelBlocker && (
        <section style={{ ...card, marginTop: 12 }}>
          <h2 style={h2}>Cancel booking</h2>
          {!quote ? (
            <>
              <p style={muted}>See the airline's cancellation charges and your refund before deciding. Nothing is cancelled until you confirm.</p>
              {quoteError && <div style={errBox}>{quoteError}</div>}
              <button disabled={busy} style={secondaryBtnBtn} onClick={() => run(async () => {
                setQuoteError("");
                try {
                  const r = await apiCall<{ quote: Quote }>(`/api/profile/trips/${trip.id}/cancel/quote`, { method: "POST" });
                  setQuote(r.quote); setConfirmCancel(false);
                } catch (e: any) {
                  setQuoteError(e.message);
                  if (e.data?.supportSuggested) setReqType("CANCELLATION_HELP");
                }
              })}>{busy ? "Checking…" : "Check cancellation charges"}</button>
            </>
          ) : (
            <>
              <div style={row}><span>You paid</span><span>{inr(quote.amountPaid, quote.currency)}</span></div>
              <div style={row}><span>Airline & supplier cancellation charges</span><span style={{ color: "#b91c1c" }}>−{inr(quote.supplierCharges, quote.currency)}</span></div>
              {quote.serviceFee > 0 && <div style={row}><span>POOMAS service fee (non-refundable)</span><span style={{ color: "#b91c1c" }}>−{inr(quote.serviceFee, quote.currency)}</span></div>}
              <div style={{ ...row, fontSize: 17 }}><strong>Your refund</strong><strong style={{ color: "#166534" }}>{inr(quote.refundAmount, quote.currency)}</strong></div>
              <p style={{ ...muted, margin: "8px 0" }}>Refunded to {quote.refundTo} once the airline confirms the cancellation. The final amount is confirmed by the airline. This quote is valid for 10 minutes.</p>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, margin: "8px 0 12px" }}>
                <input type="checkbox" checked={confirmCancel} onChange={(e) => setConfirmCancel(e.target.checked)} style={{ marginTop: 3 }} />
                I want to cancel this booking for all travellers. I understand this can't be undone.
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button disabled={busy || !confirmCancel} style={{ ...primaryBtnBtn, opacity: busy || !confirmCancel ? .6 : 1 }} onClick={() => run(async () => {
                  const r = await apiCall<{ pending?: boolean; message?: string }>(`/api/profile/trips/${trip.id}/cancel`, { method: "POST", body: JSON.stringify({ confirm: true }) });
                  setQuote(null);
                  setNotice(r.pending && r.message ? r.message : `Cancellation submitted. Your refund goes to ${quote?.refundTo ?? "your original payment method"} once the airline confirms.`);
                  await load();
                })}>{busy ? "Cancelling…" : "Cancel booking"}</button>
                <button disabled={busy} style={secondaryBtnBtn} onClick={() => setQuote(null)}>Keep my booking</button>
              </div>
            </>
          )}
        </section>
      )}
      {mode === "guest" && ticketed && (
        <section style={{ ...card, marginTop: 12 }}>
          <h2 style={h2}>Need to cancel?</h2>
          <p style={muted}>Online cancellation is available when you're signed in to the account used for booking. Otherwise send us a cancellation request below; refunds go back to your original payment method.</p>
        </section>
      )}

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>Need help or a change?</h2>
        <p style={muted}>Date changes, extra baggage, meals or seats, and name corrections are handled by our team. Charges may apply; we'll confirm before making any change.</p>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); run(async () => {
          const path = mode === "customer" ? "/api/profile/support" : "/api/trips/support";
          await apiCall(path, { auth: mode, method: "POST", body: JSON.stringify({ type: reqType, message: reqMsg.trim(), ...(mode === "customer" ? { bookingId: trip.id } : {}) }) });
          setReqMsg(""); setNotice("Request sent. Our team will contact you by email or phone.");
          if (mode === "customer") await load();
        }); }} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <select value={reqType} onChange={(e) => setReqType(e.target.value)} style={input}>
            {SUPPORT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <textarea required minLength={5} rows={3} value={reqMsg} onChange={(e) => setReqMsg(e.target.value)} placeholder="Tell us what you need (e.g. new date, number of bags)" style={{ ...input, resize: "vertical" }} />
          <button type="submit" disabled={busy} style={{ ...primaryBtnBtn, alignSelf: "flex-start" }}>Send request</button>
        </form>
        {requests.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {requests.map((r) => (
              <div key={r.id} style={{ ...row, alignItems: "flex-start" }}>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>{SUPPORT_TYPES.find(([v]) => v === r.type)?.[1] ?? r.type}</strong>
                  <small style={{ display: "block", color: "#64748b" }}>{r.message}</small>
                  {r.adminNote && <small style={{ display: "block", color: "#0f766e", marginTop: 2 }}>POOMAS: {r.adminNote}</small>}
                </span>
                <small style={{ fontWeight: 700, color: r.status === "RESOLVED" ? "#166534" : "#92400e", whiteSpace: "nowrap" }}>{r.status.replace("_", " ").toLowerCase()}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 10, padding: "8px 10px" }}>
      <small style={{ color: "#64748b", display: "block" }}>{label}</small>
      <strong style={{ fontFamily: mono ? "monospace" : "inherit", fontSize: 15 }}>{value}</strong>
    </div>
  );
}

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 16 };
const h2: React.CSSProperties = { margin: "0 0 10px", fontSize: 16, fontWeight: 800 };
const muted: React.CSSProperties = { margin: "0 0 12px", color: "#64748b", fontSize: 13 };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid #f1f5f9", fontSize: 14 };
const input: React.CSSProperties = { padding: "11px 12px", border: "1.5px solid #e2e8f0", borderRadius: 10, fontSize: 15, fontFamily: "inherit", width: "100%", boxSizing: "border-box" };
const primaryBtn: React.CSSProperties = { display: "inline-block", background: "#E31E24", color: "#fff", borderRadius: 10, padding: "10px 14px", fontWeight: 800, fontSize: 14, textDecoration: "none", border: 0, cursor: "pointer", fontFamily: "inherit" };
const secondaryBtn: React.CSSProperties = { ...primaryBtn, background: "#fff", color: "#0f172a", border: "1.5px solid #e2e8f0" };
const primaryBtnBtn = primaryBtn;
const secondaryBtnBtn = secondaryBtn;
const errBox: React.CSSProperties = { background: "#FEE2E2", color: "#991B1B", padding: "10px 14px", borderRadius: 10, fontSize: 14, marginTop: 12 };
const okBox: React.CSSProperties = { background: "#DCFCE7", color: "#166534", padding: "10px 14px", borderRadius: 10, fontSize: 14, marginTop: 12 };
