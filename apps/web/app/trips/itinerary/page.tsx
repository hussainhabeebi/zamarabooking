"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiCall, downloadFile, inr, openETicket, readGuestToken } from "../../lib/customer-api";
import styles from "./itinerary.module.css";

// Itinerary confirmation: the payment-result page sends the traveller here with a
// read-only trip token. We wait for the airline booking, then download the
// itinerary (live TripJack booking details) automatically.

interface Segment { airline: string; airlineName: string; flightNumber: string; from: { code: string; city?: string; terminal?: string }; to: { code: string; city?: string; terminal?: string }; departure: string; arrival: string; durationMin?: number; cabinBaggage?: string; checkedBaggage?: string }
interface Trip {
  id: string; status: string; pnr: string | null; origin: string; destination: string; departureDate: string | null;
  currency: string; totalAmount: number; contactEmail: string | null;
  passengers: { id: string; type: string; firstName: string; lastName: string }[];
  itinerary: { pnr?: string; segments: Segment[]; travellers: { name: string; type?: string; pnr?: string; ticketNumber?: string }[] } | null;
}

const POLL_MS = 4000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const CONFIRMED = ["CONFIRMED", "TICKETED"];
const FINISHED = [...CONFIRMED, "PAYMENT_FAILED", "CANCELLED", "REFUND_PENDING", "REFUNDED"];

// TripJack times are airport-local without an offset: show them as written.
function split(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return { date: s, time: "" };
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return { date, time: `${m[4]}:${m[5]}` };
}

export default function ItineraryConfirmationPage() {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  const [download, setDownload] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [downloadError, setDownloadError] = useState("");
  const startedAt = useRef(Date.now());
  const autoTried = useRef(false);

  const [hasToken, setHasToken] = useState(true);

  const confirmed = CONFIRMED.includes(trip?.status ?? "");
  const pnr = trip?.pnr ?? trip?.itinerary?.pnr ?? null;
  const fileName = `itinerary-${(pnr ?? trip?.id.slice(0, 8) ?? "booking").replace(/[^A-Za-z0-9-]/g, "")}.html`;

  const saveItinerary = useCallback(async () => {
    setDownload("busy"); setDownloadError("");
    try {
      await downloadFile("/api/trips/itinerary", "guest", fileName);
      setDownload("done");
      try { if (trip) sessionStorage.setItem(`itinerary_downloaded:${trip.id}`, "1"); } catch {}
    } catch (e: any) {
      setDownload("failed"); setDownloadError(e.message);
    }
  }, [fileName, trip]);

  // Follow the booking until the airline confirms it (or it fails).
  useEffect(() => {
    if (!readGuestToken()) { setHasToken(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      try {
        const d = await apiCall<{ trip: Trip }>("/api/trips/view", { auth: "guest" });
        if (stopped) return;
        setTrip(d.trip);
        const done = FINISHED.includes(d.trip.status);
        // Once confirmed, keep polling briefly until TripJack returns the flight details.
        const waitingForDetails = CONFIRMED.includes(d.trip.status) && !d.trip.itinerary?.segments.length;
        if (done && !waitingForDetails) return;
      } catch (e: any) {
        if (stopped) return;
        if (e.status === 401 || e.status === 404) { setError(e.message); return; }
      }
      if (Date.now() - startedAt.current > MAX_WAIT_MS) { setTimedOut(true); return; }
      timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  // Download the itinerary automatically once, as soon as the flight details are in.
  useEffect(() => {
    if (!trip || !confirmed || !trip.itinerary?.segments.length || autoTried.current) return;
    autoTried.current = true;
    try { if (sessionStorage.getItem(`itinerary_downloaded:${trip.id}`)) { setDownload("done"); return; } } catch {}
    saveItinerary();
  }, [trip, confirmed, saveItinerary]);

  if (!hasToken || error) {
    return (
      <main className="page-container" style={{ padding: "32px 16px", maxWidth: 560 }}>
        <section style={card}>
          <h1 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800 }}>Find your itinerary</h1>
          <p style={muted}>{error || "This confirmation link has expired."} Look up your booking with your PNR or booking reference and email to download the itinerary.</p>
          <a href="/trips/find" style={primaryBtn}>Find my booking</a>
        </section>
      </main>
    );
  }

  if (!trip) {
    return <main className="page-container" style={{ padding: "32px 16px" }}>Loading your booking…</main>;
  }

  const failed = ["PAYMENT_FAILED", "CANCELLED", "REFUND_PENDING", "REFUNDED"].includes(trip.status);
  const segs = trip.itinerary?.segments ?? [];
  const travellers = trip.itinerary?.travellers?.length ? trip.itinerary.travellers
    : trip.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, type: p.type, ticketNumber: undefined as string | undefined }));

  return (
    <main className={styles.page}>
      <section className={styles.confirmation} aria-labelledby="confirmation-title">
        <div className={`${styles.statusIcon} ${confirmed ? styles.confirmed : failed ? styles.failed : styles.pending}`} aria-hidden="true">
          {confirmed ? "✓" : failed ? "×" : "…"}
        </div>
        <div className={styles.confirmationContent}>
          <h1 id="confirmation-title">{confirmed ? "Booking confirmed" : failed ? "Booking could not be completed" : "Confirming your seat with the airline"}</h1>
          {confirmed && <p className={styles.journey}>{trip.origin} <span aria-label="to">→</span> {trip.destination}<span className={styles.travellerCount}> · {travellers.length} traveller{travellers.length > 1 ? "s" : ""}</span></p>}
          <p className={styles.message}>
            {confirmed
              ? `${download === "done" ? "Your itinerary has been downloaded." : download === "busy" ? "Downloading your itinerary…" : "Your booking details are below."}${trip.contactEmail ? ` The e-ticket is also on its way to ${trip.contactEmail}.` : ""}`
              : failed
                ? "The airline couldn't confirm this booking. Your payment is being refunded to your original payment method."
                : timedOut
                  ? "This is taking longer than usual. You don't need to pay again — we'll email your itinerary as soon as the airline confirms. You can also check My Trips later."
                  : "Payment received. Keep this page open — your itinerary downloads automatically once the airline issues the ticket (usually under a minute)."}
          </p>
        </div>
        {confirmed && <div className={styles.summary}>
          <Info label="Airline PNR" value={pnr ?? "Pending"} mono />
          <Info label="Booking ID" value={trip.id.slice(0, 8).toUpperCase()} mono />
          <Info label="Total paid" value={inr(trip.totalAmount, trip.currency)} />
        </div>}
      </section>

      {confirmed && <section className={styles.actionsPanel} aria-label="Booking documents and actions">
        <div className={styles.actions}>
          <button onClick={() => { setDownloadError(""); downloadFile("/api/trips/eticket", "guest", fileName.replace(/^itinerary-/, "e-ticket-")).catch((e) => setDownloadError(e.message)); }} className={styles.primaryAction}>Download e-ticket</button>
          <button onClick={() => { setDownloadError(""); openETicket("/api/trips/eticket", "guest").catch((e) => setDownloadError(e.message)); }} className={styles.secondaryAction}>View / print e-ticket</button>
          <button disabled={download === "busy" || !segs.length} onClick={saveItinerary} className={styles.secondaryAction}>
            {download === "busy" ? "Downloading…" : "Download itinerary"}
          </button>
          <a href="/trips/guest" className={styles.manageAction}>Manage booking <span aria-hidden="true">→</span></a>
        </div>
        {downloadError && <div style={errBox}>{downloadError}</div>}
      </section>}

      {(confirmed || segs.length > 0) && <section className={styles.card} aria-labelledby="itinerary-title">
        <h2 id="itinerary-title" className={styles.sectionTitle}>Flight itinerary</h2>
        {segs.length === 0 ? <p style={muted}>Fetching flight details from the airline…</p> : segs.map((s, i) => {
          const dep = split(s.departure), arr = split(s.arrival);
          return <div key={i} className={styles.segment}>
            <div className={styles.segmentHeading}>
              <strong>{s.airlineName || s.airline}</strong>
              {segs.length > 1 && <span>Flight {i + 1} of {segs.length}</span>}
            </div>
            <div className={styles.route}>
              <div className={styles.airport}>
                <strong className={styles.airportCode}>{s.from.code}</strong>
                {s.from.city && <span className={styles.city}>{s.from.city}</span>}
                {dep.time && <strong className={styles.time}>{dep.time}</strong>}
                {s.from.terminal && <span className={styles.detail}>{s.from.terminal}</span>}
                {dep.date && <span className={styles.detail}>{dep.date}</span>}
              </div>
              <div className={styles.routeConnector}>
                {s.flightNumber && <span className={styles.flightNumber}>{s.flightNumber}</span>}
                <div className={styles.routeLine}><span /><PlaneIcon /><span /></div>
                {s.durationMin ? <span className={styles.duration}>{Math.floor(s.durationMin / 60)}h {s.durationMin % 60}m</span> : null}
              </div>
              <div className={`${styles.airport} ${styles.arrival}`}>
                <strong className={styles.airportCode}>{s.to.code}</strong>
                {s.to.city && <span className={styles.city}>{s.to.city}</span>}
                {arr.time && <strong className={styles.time}>{arr.time}</strong>}
                {s.to.terminal && <span className={styles.detail}>{s.to.terminal}</span>}
                {arr.date && <span className={styles.detail}>{arr.date}</span>}
              </div>
            </div>
            {(s.cabinBaggage || s.checkedBaggage) && <small className={styles.baggage}>Baggage: {[s.cabinBaggage && `cabin ${s.cabinBaggage}`, s.checkedBaggage && `check-in ${s.checkedBaggage}`].filter(Boolean).join(" · ")}</small>}
          </div>;
        })}
      </section>}

      {confirmed && <section className={styles.card} aria-labelledby="travellers-title">
        <h2 id="travellers-title" className={styles.sectionTitle}>Travellers</h2>
        <div className={styles.travellerTable}>
          <div className={styles.tableHeading} aria-hidden="true"><span>Passenger</span><span>Type</span><span>Ticket number</span></div>
          {travellers.map((t, i) => <div key={i} className={styles.travellerRow}>
            <strong className={styles.passengerName}>{t.name}</strong>
            <span className={styles.passengerType}>{t.type ? t.type.toLowerCase() : ""}</span>
            <span className={styles.ticketNumber}>{t.ticketNumber && <><span className={styles.mobileTicketLabel}>Ticket </span>{t.ticketNumber}</>}</span>
          </div>)}
        </div>
      </section>}

      <div className={styles.footer}><a href="/">Back to home</a></div>
    </main>
  );
}

function PlaneIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3 11 6 1 7-8 2 1-4 8 6 2v2l-7-1-3 5-2-1 1-5-6-2z" fill="currentColor" /></svg>;
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.summaryItem}>
      <small>{label}</small>
      <strong className={mono ? styles.mono : undefined}>{value}</strong>
    </div>
  );
}

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 16 };
const muted: React.CSSProperties = { margin: "0 0 12px", color: "#64748b", fontSize: 14, lineHeight: 1.55 };
const primaryBtn: React.CSSProperties = { display: "inline-block", background: "#E31E24", color: "#fff", borderRadius: 10, padding: "10px 14px", fontWeight: 800, fontSize: 14, textDecoration: "none", border: 0, cursor: "pointer", fontFamily: "inherit" };
const errBox: React.CSSProperties = { background: "#FEE2E2", color: "#991B1B", padding: "10px 14px", borderRadius: 10, fontSize: 14, marginTop: 12 };
