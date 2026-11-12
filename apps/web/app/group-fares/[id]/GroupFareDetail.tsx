"use client";
// Website → Group fares → one fare: details, the price for the chosen travellers, and Book now,
// which opens the normal booking page (traveller details → payment). The booking is priced again
// on the server at checkout and the seats are held there, so nothing here is trusted for price.
import { useEffect, useState } from "react";
import { CABIN, groupFaresUrl, HEADERS, inr, saleEnds, seatsText, travelDay, type GroupFare } from "../group-fares";
import styles from "../group-fares.module.css";

interface Quote {
  pax: { adults: number; children: number; infants: number };
  total: number; currency: "INR"; problem: string | null;
  book: { fareId: string; supplier: string; airline: string; fn: string; from: string; to: string; dep: string; arr: string;
    dur: number; stops: number; bag: string; cab: string; ref: boolean; cls: string; fl: string };
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

export default function GroupFareDetail({ id }: { id: string }) {
  const [fare, setFare] = useState<GroupFare | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pax, setPax] = useState<{ adults: number; children: number; infants: number } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");

  useEffect(() => {
    const q = pax ? `?adults=${pax.adults}&children=${pax.children}&infants=${pax.infants}` : "";
    let cancelled = false;
    fetch(groupFaresUrl(`/${encodeURIComponent(id)}${q}`), { headers: HEADERS, cache: "no-store" })
      .then(async (r) => {
        if (r.status === 404) { if (!cancelled) setState("gone"); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as { fare: GroupFare; quote: Quote };
        if (cancelled) return;
        setFare(d.fare); setQuote(d.quote); setState("ready");
        if (!pax) setPax(d.quote.pax);
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [id, pax]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "loading" && !fare) return <main className={`page-container ${styles.page}`}><p className={styles.muted}>Loading group fare…</p></main>;
  if (state === "gone") return (
    <main className={`page-container ${styles.page}`}>
      <h1 className={styles.title}>Group fare not available</h1>
      <div className={styles.empty}><p>This group fare has ended, sold out or is no longer offered.</p><p><a href="/group-fares">See other group fares</a> or <a href="/#flight-search">search all flights</a>.</p></div>
    </main>
  );
  if (!fare || !quote || !pax) return <main className={`page-container ${styles.page}`}><p className={styles.error}>We couldn&apos;t load this group fare. Please try again in a moment.</p></main>;

  const maxSeats = Math.min(9, fare.maxPax ?? 9, Math.max(fare.seatsLeft, 1));
  const seats = pax.adults + pax.children;
  const soldOut = fare.seatsLeft < Math.max(1, fare.minPax);
  const change = (k: "adults" | "children" | "infants", v: number) => {
    const next = { ...pax, [k]: v };
    next.infants = Math.min(next.infants, next.adults, 4);   // one lap infant per adult
    setPax(next);
  };

  function bookNow() {
    if (!quote || quote.problem) return;
    const b = quote.book;
    const p = new URLSearchParams({
      fareId: b.fareId, supplier: b.supplier, adults: String(quote.pax.adults), children: String(quote.pax.children), infants: String(quote.pax.infants),
      airline: b.airline, fn: b.fn, from: b.from, to: b.to, dep: b.dep, arr: b.arr, dur: String(b.dur), stops: String(b.stops),
      price: String(quote.total), cur: "INR", ref: b.ref ? "1" : "0", bag: b.bag, cab: b.cab, cls: b.cls, fl: b.fl,
    });
    window.location.href = `/book?${p.toString()}`;
  }

  return (
    <main className={`page-container ${styles.page}`}>
      <p style={{ margin: "0 0 10px" }}><a href="/group-fares" className={styles.back}>‹ All group fares</a></p>
      <h1 className={styles.title}>{fare.title}</h1>
      <p className={styles.lead}>{fare.origin} → {fare.destination} · {travelDay(fare.travelDate)}</p>

      <div className={styles.detail}>
        <section className={styles.panel}>
          <h2>Flight</h2>
          <dl className={styles.facts}>
            <div><dt>Airline</dt><dd>{fare.airlineName} {fare.flightNumber}</dd></div>
            <div><dt>Departs</dt><dd>{fare.origin} {fare.departureTime}</dd></div>
            <div><dt>Arrives</dt><dd>{fare.destination} {fare.arrivalTime}{fare.arrivalDayOffset ? ` (+${fare.arrivalDayOffset} day)` : ""}</dd></div>
            <div><dt>Stops</dt><dd>{fare.stops ? `${fare.stops} stop${fare.stops > 1 ? "s" : ""}` : "Non-stop"}</dd></div>
            <div><dt>Cabin</dt><dd>{CABIN[fare.cabinClass] ?? fare.cabinClass}</dd></div>
            <div><dt>Checked baggage</dt><dd>{fare.baggage.checked}</dd></div>
            <div><dt>Cabin baggage</dt><dd>{fare.baggage.cabin}</dd></div>
            <div><dt>Cancellation</dt><dd>{fare.isRefundable ? "Refundable (airline rules apply)" : "Non-refundable"}</dd></div>
            <div><dt>Seats</dt><dd className={soldOut ? styles.soldOut : styles.seats}>{seatsText(fare)}</dd></div>
            {fare.saleEndsAt && <div><dt>Sale ends</dt><dd>{saleEnds(fare.saleEndsAt)}</dd></div>}
          </dl>
          {fare.description && <p className={styles.description}>{fare.description}</p>}
        </section>

        <section className={styles.panel}>
          <h2>Travellers and price</h2>
          <div className={styles.paxRow}>
            <label>Adults (12+)
              <select value={pax.adults} onChange={(e) => change("adults", Number(e.target.value))}>{range(1, Math.min(9, maxSeats)).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <label>Children (2–11)
              <select value={pax.children} onChange={(e) => change("children", Number(e.target.value))}>{range(0, Math.max(0, Math.min(6, maxSeats - pax.adults))).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <label>Infants (under 2)
              <select value={pax.infants} onChange={(e) => change("infants", Number(e.target.value))}>{range(0, Math.min(pax.adults, 4)).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
          </div>
          {fare.minPax > 1 && <p className={styles.note}>This fare is for at least {fare.minPax} travellers (adults and children){fare.maxPax ? `, up to ${fare.maxPax}` : ""}.</p>}
          <div className={styles.total}>
            <span>{seats} seat{seats === 1 ? "" : "s"}{pax.infants ? ` + ${pax.infants} infant${pax.infants === 1 ? "" : "s"}` : ""}</span>
            <span className="fare-card-price">{inr(quote.total)}</span>
          </div>
          <p className={styles.note} style={{ marginTop: 2 }}>Total, taxes included{fare.pricePerAdult != null ? ` · ${inr(fare.pricePerAdult)} per adult` : ""}</p>
          {quote.problem && <p className={styles.problem}>{quote.problem}</p>}
          <button type="button" className={`fare-card-book-btn ${styles.book}`} disabled={!!quote.problem || soldOut || state === "loading"} onClick={bookNow} style={{ marginTop: 14 }}>
            {soldOut ? "Sold out" : "Book now"}
          </button>
          <p className={styles.note}>
            Next you enter traveller details and pay online. Your seats are held while you pay. We issue the ticket on the group booking and email it to you.
            Need more than 9 seats? <a href="/contact" className={styles.back}>Contact us</a>.
          </p>
        </section>
      </div>
    </main>
  );
}
